import type { ClarifyCopy } from './types_clarify'

export const jaClarify: Partial<ClarifyCopy> = {
  notReady: '明確化リクエストはまだ準備できていません',
  gatewayDisconnected: 'Hermes ゲートウェイが接続されていません',
  sendFailed: '明確化応答を送信できませんでした',
  loadingQuestion: '質問を読み込み中…',
  other: 'その他（回答を入力）',
  placeholder: '回答を入力…',
  skip: 'スキップ',
  skipped: 'スキップ済み',
  noAnswer: '回答なし',
  confirmAndContinueLabel: '確定して続行',
  singleSelectHint: '1つ選ぶ',
  multiSelectHint: '該当するものをすべて選択',
  oneQuestion: '1問',
  questionProgress: (answered, total) => `${total}問中${answered}問回答済み`,
  notDelivered:
    'この質問はアプリに届かなかったため、ここでは回答できません。停止を押してターンを終了し、チャットで返信してください。',
  draftSaved: '下書きを保存しました',
  draftDeviceOnly: '下書きはこのデバイスにのみ保存されています',
  draftServerUnavailable: 'サーバーへの自動保存は利用できません：下書きはこのデバイスにのみ保存されています',
  draftsHeading: '未送信の下書き',
  draftsAssistantNotice: 'アシスタントには、これらは回答ではなく下書きだと伝えられています。',
  draftsDeviceOnlyNotice: 'アシスタントはこれらの下書きを見ていません。',
  draftsContinue: 'このフォームは閉じたため送信できません。続けるには下書きをコピーして返信に貼り付けてください。',
  draftsCopy: '下書きをコピー',
  draftNotInTranscript: 'アシスタントはこの下書きを見ていません',
  draftDiskConfirmed: '自動保存を確認済み: サーバーのディスクに保存されました',
  draftDiskNotSaved: 'サーバーは、この下書きがディスクに保存されていないと報告しました',
  draftDiskUnknown: 'サーバーのディスクへの保存は未確認です',
  draftsMemoryOnlyNotice:
    'このデバイスはこれらの下書きを保存できませんでした。このウィンドウにのみ残っています。今すぐコピーしてください。',
  draftServerUnconfirmed:
    '下書きをサーバーに送信しましたが、ディスクへの保存はまだ確認されていません。このデバイスに保存されています',
  draftsDiscard: '下書きを破棄',
  draftNotSavedOwner:
    '保存されていません: このフォームがどの会話に属するか確認できませんでした。閉じる前にテキストをコピーしてください。',
  draftServerOnly: '下書きはサーバーにのみ保存されました: このデバイスにはコピーを保存できませんでした',
  draftNotSaved:
    '保存されていません: このデバイスは最新の変更を保存できず、サーバーも確認していません。フォームが閉じる前にテキストをコピーしてください。',
  draftNewerOnDevice: 'アシスタントに伝えた版より新しい内容です',
  draftsRecall: 'サーバーに保存された下書きを表示',
  draftsRecalling: '保存された下書きを読み込み中…',
  draftsRecallUnavailable: 'このサーバーは保存された下書きを呼び出せません。このデバイスのコピーのみ表示できます。',
  draftsRecallFailed: 'サーバーに保存された下書きを読み込めませんでした。接続後にもう一度お試しください。',
  draftsRecallNone: 'このフォームの下書きはサーバーに保存されていません。',
  draftsListNotice:
    'この会話でサーバーに保存された下書き (新しい順)。このフォームとは関連付けられていません。使う前に質問を確認してください。',
  draftsListNone: 'この会話の下書きはサーバーに保存されていません。',
  draftsDiscarding: '下書きを破棄中…',
  draftsDiscarded: (device: boolean, server: string) => {
    const here = device ? 'このデバイスから削除しました' : 'このデバイスには何も保存されていませんでした'

    if (server === 'removed') {
      return device ? 'このデバイスとサーバーから削除しました。' : 'サーバーから削除しました。'
    }

    if (server === 'missing') {
      return `${here}。サーバーにはコピーがありませんでした。`
    }

    if (server === 'unsupported') {
      return `${here}。このサーバーは保存された下書きを削除できないため、サーバー上のコピーは残ります。`
    }

    return server === 'unreachable'
      ? `${here}。サーバーに接続できなかったため、サーバー上のコピーは残ります。`
      : `${here}。ただしサーバーのコピーは削除できませんでした。引き続きサーバーから呼び出せます。`
  }
}
