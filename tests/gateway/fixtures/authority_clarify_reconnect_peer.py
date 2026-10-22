"""A Desktop-shaped viewer's batch clarify survives a FORCED socket close, end to end.

Real GatewayRunner + session API WebSocket, a loopback model asking two questions, the real clarify tool. One
socket plays the Desktop: it creates a ``gui`` session, submits with ``clarify_batch`` and receives the ONE ``clarify``
server request. It locks one answer and saves two drafts, then its connection is aborted without a close handshake
(what a 1006 or a renderer reload looks like to the owner). A fresh socket does the reconnect handshake
(``session.events.since`` then ``session.resume``): the still-open request must come back with the lock and the drafts,
and the same request must then settle through the new socket with the answers reaching the real model.
"""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import traceback


class ModelPeer(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"data": []}')

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        messages = body.get('messages', [])
        self.server.requests.append(messages)
        asking = bool(messages) and not any(m['role'] == 'tool' for m in messages)
        message = {'role': 'assistant', 'content': 'CLARIFY_FINISHED'}
        if asking:
            message = {'role': 'assistant', 'content': None, 'tool_calls': [{
                'index': 0, 'id': 'reconnect-clarify', 'type': 'function', 'function': {
                    'name': 'clarify', 'arguments': json.dumps({'questions': [
                        {'question': 'Pick a drink', 'choices': ['Coffee', 'Tea']},
                        {'question': 'Pick a time', 'choices': ['Morning', 'Night']}]})}}]}
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream' if body.get('stream') else 'application/json')
        self.end_headers()
        if body.get('stream'):
            for delta, finish in [(message, None), ({}, 'tool_calls' if asking else 'stop')]:
                frame = {'id': 'local', 'object': 'chat.completion.chunk', 'created': 1,
                         'model': 'local', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
                self.wfile.write(('data: ' + json.dumps(frame) + '\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')
        else:
            self.wfile.write(json.dumps({'id': 'local', 'choices': [{'index': 0, 'message': message,
                'finish_reason': 'tool_calls' if asking else 'stop'}]}).encode())
        self.wfile.flush()


async def probe(peer):
    import websockets
    from gateway.run import GatewayRunner
    from gateway.run_api import start_gateway_api, stop_gateway_api
    from gateway.session_authority import initialize_session_authority
    from hermes_cli import web_server
    from tests.waiting import async_wait_until

    runner = GatewayRunner()
    authority = await initialize_session_authority(runner, profile_id=os.environ['HERMES_HOME'], instance_id='reconnect')
    api = await start_gateway_api(runner)
    url = api.api_origin.replace('http:', 'ws:') + '/api/ws?token=' + web_server._SESSION_TOKEN
    frames = {}

    async def rpc(ws, rid, method, **params):
        await ws.send(json.dumps({'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params}))
        async with asyncio.timeout(20):
            while True:
                frame = json.loads(await ws.recv())
                frames.setdefault(id(ws), []).append(frame)
                if frame.get('id') == rid and 'method' not in frame:
                    return frame

    async def server_request(ws, method):
        for frame in frames.get(id(ws), []):
            if frame.get('method') == method and isinstance(frame.get('id'), str):
                return frame
        async with asyncio.timeout(20):
            while True:
                frame = json.loads(await ws.recv())
                frames.setdefault(id(ws), []).append(frame)
                if frame.get('method') == method and isinstance(frame.get('id'), str):
                    return frame

    desktop = reconnected = None
    sid = None
    try:
        desktop = await websockets.connect(url)
        created = await rpc(desktop, 1, 'session.create', source='gui', request_id='create-1', cwd=os.getcwd())
        assert 'result' in created, created
        sid = created['result']['session_id']
        submitted = await rpc(desktop, 2, 'prompt.submit', session_id=sid, input_id='ask-1', text='Ask me',
                              clarify_batch=True)
        assert 'result' in submitted, submitted
        request = await server_request(desktop, 'clarify')
        rid, questions = request['id'], request['params']['questions']
        assert [q['question'] for q in questions] == ['Pick a drink', 'Pick a time'], questions
        first, second = questions[0]['qid'], questions[1]['qid']
        locked = await rpc(desktop, 3, 'clarify.lock', request_id=rid, question_id=first, answer='Tea')
        assert locked.get('result', {}).get('remaining') == [second], locked
        saved = await rpc(desktop, 4, 'clarify.draft', session_id=sid, request_id=rid, question_id=second,
                          choices=['Night'], text='Other: after dinner\nplease', revision=7)
        assert saved.get('result') == {'status': 'ok', 'revision': 7, 'durable': True}, saved
        watermark = (await rpc(desktop, 5, 'session.events.since', session_id=sid, last_sequence=0))['result']
        # The connection dies without a close handshake: the owner never hears a goodbye, the card is still open.
        desktop.transport.abort()
        await async_wait_until(lambda: not authority.sessions[sid].subscribers, timeout=20,
                               what="the owner to see the dropped socket")

        reconnected = await websockets.connect(url)
        since = await rpc(reconnected, 1, 'session.events.since', session_id=sid,
                          replay_epoch=watermark['replay_epoch'], last_sequence=watermark['last_sequence'])
        resumed = await rpc(reconnected, 2, 'session.resume', session_id=sid)
        assert 'result' in resumed, resumed
        expected = [{'id': rid, 'method': 'clarify', 'params': {
            'session_id': sid, 'questions': questions, 'answers': {first: 'Tea'},
            'drafts': {second: {'choices': ['Night'], 'text': 'Other: after dinner\nplease', 'revision': 7}}}}]
        # (events.since before the new socket attached: not yet entitled; resume attaches it and restores the card.)
        assert 'open_requests' not in since.get('result', {}), since
        assert resumed['result'].get('open_requests') == expected, resumed['result'].get('open_requests')
        again = await rpc(reconnected, 3, 'session.events.since', session_id=sid,
                          replay_epoch=resumed['result']['replay_epoch'], last_sequence=resumed['result']['last_sequence'])
        assert again['result'].get('open_requests') == expected, again
        # The restored card works: the last lock through the NEW socket settles the very same request.
        last = await rpc(reconnected, 4, 'clarify.lock', request_id=rid, question_id=second, answer='Night')
        assert last.get('result') == {'status': 'ok', 'remaining': []}, last
        await asyncio.wait_for(authority.sessions[sid].task, 20)
        tools = [m for messages in peer.requests for m in messages if m['role'] == 'tool']
        dumped = json.dumps(tools)
        assert 'Tea' in dumped and 'Night' in dumped and 'submitted' in dumped, tools
        assert 'drafts_submitted' not in dumped, 'a submitted batch carries no unsent drafts'
        after = await rpc(reconnected, 5, 'session.resume', session_id=sid)
        assert 'open_requests' not in after['result'], after['result'].get('open_requests')
        Path(os.environ['HERMES_HOME'], 'reconnect-passed').write_text('the open batch survived the forced close')
    finally:
        task = authority.sessions[sid].task if sid in authority.sessions else None
        if task is not None and not task.done():
            task.cancel()
        for ws in (desktop, reconnected):
            if ws is not None:
                await ws.close()
        await stop_gateway_api(api)


def main():
    peer = ThreadingHTTPServer(('127.0.0.1', 0), ModelPeer)
    peer.requests = []
    threading.Thread(target=peer.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{peer.server_port}/v1'
    os.environ.update(OPENAI_API_KEY='loopback-only', OPENAI_BASE_URL=url)
    Path(os.environ['HERMES_HOME'], 'config.yaml').write_text(
        f'model:\n  default: local\n  provider: custom\n  base_url: {url}\n'
        'agent:\n  clarify_timeout: 60\nauxiliary:\n  title_generation:\n    enabled: false\n')
    try:
        asyncio.run(probe(peer))
    finally:
        peer.shutdown()
        peer.server_close()


if __name__ == '__main__':
    status = 0
    try:
        main()
    except BaseException:
        traceback.print_exc()
        status = 1
    os._exit(status)
