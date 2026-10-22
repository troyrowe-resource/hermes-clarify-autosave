import type { ClarifyCopy } from './types_clarify'

export const enClarify: ClarifyCopy = {
  notReady: 'Clarify request is not ready yet',
  gatewayDisconnected: 'Hermes is offline right now. Reconnect, then send it again.',
  sendFailed: 'Could not send clarify response',
  loadingQuestion: 'Loading question…',
  other: 'Other (type your answer)',
  placeholder: 'Type your answer…',
  skip: 'Skip',
  skipped: 'Skipped',
  noAnswer: 'No answer',
  confirmAndContinueLabel: 'Confirm and continue',
  singleSelectHint: 'Pick one',
  multiSelectHint: 'Select all that apply',
  oneQuestion: '1 question',
  questionProgress: (answered, total) => `${answered} of ${total} answered`,
  notDelivered:
    "This question didn't reach the app, so it can't be answered here. Press Stop to end the turn, then reply in chat.",
  draftSaved: 'Draft saved',
  draftDeviceOnly: 'Draft kept on this device only',
  draftServerUnavailable: 'Server autosave unavailable: draft kept on this device only',
  draftsHeading: 'Unsubmitted drafts',
  draftsAssistantNotice: 'The assistant was told these are drafts, not answers.',
  draftsDeviceOnlyNotice: 'The assistant has not seen these drafts.',
  draftsContinue: 'This form has closed and can no longer be submitted. Copy the drafts into a reply to continue.',
  draftsCopy: 'Copy drafts',
  draftNotInTranscript: 'The assistant has not seen this draft',
  draftDiskConfirmed: 'Autosave confirmed: saved on the server disk',
  draftDiskNotSaved: 'The server reported this draft is not saved to its disk',
  draftDiskUnknown: 'Server disk save not confirmed',
  draftsMemoryOnlyNotice: 'This device could not store these drafts: only this window holds them. Copy them now.',
  draftServerUnconfirmed: 'Draft sent to the server, not yet confirmed on its disk; kept on this device',
  draftsDiscard: 'Discard drafts',
  draftNotSavedOwner:
    'Not saved: this form could not confirm which conversation owns it. Copy your text before the form closes.',
  draftServerOnly: 'Draft saved on the server only: this device could not store a copy',
  draftNewerOnDevice: 'Newer than the copy the assistant was told',
  draftsRecall: 'Show drafts saved on the server',
  draftsRecalling: 'Reading saved drafts…',
  draftsRecallUnavailable: 'This server cannot recall saved drafts. Only a copy on this device can be shown.',
  draftsRecallFailed: 'Could not read the drafts saved on the server. Try again once connected.',
  draftsRecallNone: 'The server holds no saved drafts for this form.',
  draftsListNotice:
    'Drafts saved on the server for this conversation, newest first. They are not matched to this form: check the questions before using them.',
  draftsListNone: 'The server holds no saved drafts for this conversation.',
  draftsDiscarding: 'Discarding drafts…',
  draftsDiscarded: (device, server) => {
    const here = device ? 'Removed from this device' : 'Nothing was saved on this device'

    switch (server) {
      case 'removed':
        return device ? 'Removed from this device and the server.' : 'Removed from the server.'

      case 'missing':
        return `${here}; the server held no copy.`

      case 'unsupported':
        return `${here}. This server cannot remove saved drafts, so any copy it holds remains.`

      case 'unreachable':
        return `${here}. The server could not be reached, so any copy it holds remains.`

      default:
        return `${here}, but the copy could not be removed from the server: it can still be recalled there.`
    }
  },
  draftNotSaved:
    'Not saved: this device could not store your latest changes and the server has not confirmed them. Copy your text before the form closes.'
}
