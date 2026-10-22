import type { ClarifyCopy } from './types_clarify'

export const zhClarify: Partial<ClarifyCopy> = {
  notReady: '澄清请求尚未就绪',
  gatewayDisconnected: 'Hermes 网关未连接',
  sendFailed: '无法发送澄清响应',
  loadingQuestion: '正在加载问题…',
  other: '其他 (输入你的答案)',
  placeholder: '输入你的答案…',
  skip: '跳过',
  skipped: '已跳过',
  noAnswer: '未回答',
  confirmAndContinueLabel: '确认并继续',
  singleSelectHint: '选一个',
  multiSelectHint: '可多选',
  oneQuestion: '1 个问题',
  questionProgress: (answered, total) => `已回答 ${answered}/${total}`,
  notDelivered: '此问题未送达应用，无法在此回答。请按停止结束本轮，然后在聊天中回复。',
  draftSaved: '草稿已保存',
  draftDeviceOnly: '草稿仅保存在此设备上',
  draftServerUnavailable: '服务器自动保存不可用：草稿仅保存在此设备上',
  draftsHeading: '未提交的草稿',
  draftsAssistantNotice: '已告知助手这些是草稿，不是答案。',
  draftsDeviceOnlyNotice: '助手尚未看到这些草稿。',
  draftsContinue: '此表单已关闭，无法再提交。请将草稿复制到回复中以继续。',
  draftsCopy: '复制草稿',
  draftNotInTranscript: '助手尚未看到此草稿',
  draftDiskConfirmed: '自动保存已确认：已保存到服务器磁盘',
  draftDiskNotSaved: '服务器报告此草稿未保存到其磁盘',
  draftDiskUnknown: '服务器磁盘保存未确认',
  draftsMemoryOnlyNotice: '此设备无法存储这些草稿：只有此窗口保留着它们。请立即复制。',
  draftServerUnconfirmed: '草稿已发送到服务器，尚未确认保存到其磁盘；已保存在此设备上',
  draftsDiscard: '丢弃草稿',
  draftNotSavedOwner: '未保存：此表单无法确认它属于哪个对话。请在表单关闭前复制你的文字。',
  draftServerOnly: '草稿仅保存在服务器上：此设备无法保存副本',
  draftNotSaved: '未保存：此设备无法保存你的最新更改，服务器也未确认。请在表单关闭前复制你的文字。',
  draftNewerOnDevice: '比助手收到的版本更新',
  draftsRecall: '显示服务器上保存的草稿',
  draftsRecalling: '正在读取已保存的草稿…',
  draftsRecallUnavailable: '此服务器无法调取已保存的草稿。只能显示此设备上的副本。',
  draftsRecallFailed: '无法读取服务器上保存的草稿。连接后请重试。',
  draftsRecallNone: '服务器上没有此表单的已保存草稿。',
  draftsListNotice: '此对话在服务器上保存的草稿，按时间从新到旧排列。它们未与此表单关联：使用前请核对问题。',
  draftsListNone: '服务器上没有此对话的已保存草稿。',
  draftsDiscarding: '正在丢弃草稿…',
  draftsDiscarded: (device: boolean, server: string) => {
    const here = device ? '已从此设备删除' : '此设备上没有保存任何内容'

    if (server === 'removed') {
      return device ? '已从此设备和服务器删除。' : '已从服务器删除。'
    }

    if (server === 'missing') {
      return `${here}；服务器上没有副本。`
    }

    if (server === 'unsupported') {
      return `${here}。此服务器无法删除已保存的草稿，因此其副本仍然保留。`
    }

    return server === 'unreachable'
      ? `${here}。无法连接服务器，因此其副本仍然保留。`
      : `${here}，但无法从服务器删除副本：仍可从服务器调取。`
  }
}
