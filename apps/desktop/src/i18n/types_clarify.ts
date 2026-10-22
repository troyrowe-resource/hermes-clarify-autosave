/** The clarify question card. */
export interface ClarifyCopy {
  notReady: string
  gatewayDisconnected: string
  sendFailed: string
  loadingQuestion: string
  other: string
  placeholder: string
  skip: string
  skipped: string
  noAnswer: string
  confirmAndContinueLabel: string
  singleSelectHint: string
  multiSelectHint: string
  oneQuestion: string
  questionProgress: (answered: number, total: number) => string
  notDelivered: string
  draftSaved: string
  draftDeviceOnly: string
  draftServerUnavailable: string
  draftsHeading: string
  draftsAssistantNotice: string
  draftsDeviceOnlyNotice: string
  draftsContinue: string
  draftsCopy: string
  draftsDiscard: string
  draftServerUnconfirmed: string
  draftsMemoryOnlyNotice: string
  draftDiskUnknown: string
  draftDiskNotSaved: string
  draftDiskConfirmed: string
  draftNotInTranscript: string
  draftNotSavedOwner: string
  draftServerOnly: string
  draftNotSaved: string
  draftNewerOnDevice: string
  draftsRecall: string
  draftsRecalling: string
  draftsRecallUnavailable: string
  draftsRecallFailed: string
  draftsRecallNone: string
  draftsListNotice: string
  draftsListNone: string
  draftsDiscarding: string
  draftsDiscarded: (device: boolean, server: 'failed' | 'missing' | 'removed' | 'unreachable' | 'unsupported') => string
}
