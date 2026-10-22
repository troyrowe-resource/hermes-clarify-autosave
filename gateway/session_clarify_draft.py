"""``clarify.draft`` / ``clarify.drafts`` / ``clarify.drafts.discard`` on the session owner.

The owner's batch ``clarify`` request (``gateway/session_clarify_batch.py``) is answered per question with
``clarify.lock``; a viewer's unsent card state is saved beside it with ``clarify.draft`` and never settles
anything (``tools/clarify_drafts.py`` holds the semantics, shared with the TUI/Desktop sidecar). Every verb
uses the owner's one entitlement rule (``session_server_requests.may_settle`` / ``may_act_on_session``): a
viewer attached to that live session with ``session:respond``. A request id alone never grants access, and
another profile's same-named session has its own home, so its own store.
"""
from __future__ import annotations

from pathlib import Path

from hermes_state_runtime import RuntimeStoreError

GATEWAY = "session_owner"


def owner_home(authority) -> Path | None:
    """The owning profile's home, bound to the authority itself, never to ambient process state: a
    multiplexed authority's id IS its home path, else the directory of the authority's own session
    store (``<home>/state.db``). None when neither identifies it: the caller fails closed."""
    home = Path(str(getattr(authority, "profile_id", "") or ""))
    if home.is_absolute() and home.is_dir():
        return home
    db_path = getattr(getattr(authority, "db", None), "db_path", None)
    return Path(db_path).parent if db_path else None


def owner_draft_scope(authority, session_id):
    from tools.clarify_drafts import DraftScope
    home = owner_home(authority)
    return DraftScope(home, GATEWAY, session_id) if session_id and home is not None else None


def _ids(params, *keys):
    values = [params.get(key) for key in keys]
    if not all(isinstance(value, str) and value for value in values):
        raise RuntimeStoreError('invalid_params')
    return values


def _entitled_session(connection, params) -> str:
    from gateway.session_server_requests import may_act_on_session
    (session_id,) = _ids(params, 'session_id')
    if not may_act_on_session(connection.authority, connection.actor, session_id):
        raise RuntimeStoreError('permission_denied')
    return session_id


async def clarify_draft(connection, ref, params):
    from gateway.session_server_requests import may_settle, save_draft
    from tools.clarify_drafts import DraftError
    session_id, request_id, question_id = _ids(params, 'session_id', 'request_id', 'question_id')
    authority, actor = connection.authority, connection.actor

    def entitled(owner_session, events):
        # The lock's rule, for this very session: never a draft by request id alone.
        return owner_session == session_id and may_settle(authority, actor, owner_session, events)
    try:
        saved = save_draft(request_id, question_id, params.get('choices', []), params.get('text', ''),
                           params.get('revision'), session_ok=entitled)
    except (DraftError, ValueError):
        raise RuntimeStoreError('invalid_params') from None
    return saved if saved is not None else {'status': 'expired'}


async def clarify_drafts(connection, ref, params):
    from tools.clarify_drafts import list_records, valid_request_id
    session_id = _entitled_session(connection, params)
    request_id = params.get('request_id')
    if request_id is not None and not valid_request_id(request_id):
        raise RuntimeStoreError('invalid_params')
    scope = owner_draft_scope(connection.authority, session_id)
    return {'drafts': list_records(scope, request_id) if scope is not None else []}


async def clarify_drafts_discard(connection, ref, params):
    from gateway.session_server_requests import discard_open_drafts, may_settle
    from tools.clarify_drafts import discard, valid_request_id
    session_id = _entitled_session(connection, params)
    request_id = params.get('request_id')
    if not valid_request_id(request_id):
        raise RuntimeStoreError('invalid_params')
    authority, actor = connection.authority, connection.actor
    live = discard_open_drafts(request_id, session_ok=lambda owner_session, events: (
        owner_session == session_id and may_settle(authority, actor, owner_session, events)))
    scope = owner_draft_scope(authority, session_id)
    stored = scope is not None and discard(scope, request_id)
    return {'status': 'ok' if live or stored else 'missing'}


def handlers(connection) -> dict:
    from functools import partial
    return {'clarify.draft': partial(clarify_draft, connection),
            'clarify.drafts': partial(clarify_drafts, connection),
            'clarify.drafts.discard': partial(clarify_drafts_discard, connection)}
