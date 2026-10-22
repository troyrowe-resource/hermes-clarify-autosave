import type { ClarifyCopy } from './types_clarify'

export const deClarify: Partial<ClarifyCopy> = {
  notReady: 'Klärungsanfrage ist noch nicht bereit',
  gatewayDisconnected: 'Hermes-Gateway ist nicht verbunden',
  sendFailed: 'Klärungsantwort konnte nicht gesendet werden',
  loadingQuestion: 'Frage wird geladen…',
  other: 'Anderes (Antwort eingeben)',
  placeholder: 'Geben Sie Ihre Antwort ein…',
  skip: 'Überspringen',
  skipped: 'Übersprungen',
  noAnswer: 'Keine Antwort',
  confirmAndContinueLabel: 'Bestätigen und fortfahren',
  singleSelectHint: 'Eines auswählen',
  multiSelectHint: 'Alle Treffer auswählen',
  oneQuestion: '1 Frage',
  questionProgress: (answered, total) => `${answered} von ${total} beantwortet`,
  notDelivered:
    'Diese Frage hat die App nicht erreicht und kann hier nicht beantwortet werden. Klicken Sie auf Stopp, um den Durchgang zu beenden, und antworten Sie dann im Chat.',
  draftSaved: 'Entwurf gespeichert',
  draftDeviceOnly: 'Entwurf nur auf diesem Gerät gespeichert',
  draftServerUnavailable:
    'Automatisches Speichern auf dem Server nicht verfügbar: Entwurf nur auf diesem Gerät gespeichert',
  draftsHeading: 'Nicht gesendete Entwürfe',
  draftsAssistantNotice: 'Der Assistent weiß, dass dies Entwürfe und keine Antworten sind.',
  draftsDeviceOnlyNotice: 'Der Assistent hat diese Entwürfe nicht gesehen.',
  draftsContinue:
    'Dieses Formular ist geschlossen und kann nicht mehr gesendet werden. Kopiere die Entwürfe in eine Antwort, um fortzufahren.',
  draftsCopy: 'Entwürfe kopieren',
  draftNotInTranscript: 'Der Assistent hat diesen Entwurf nicht gesehen',
  draftDiskConfirmed: 'Automatisch gespeichert: auf dem Datenträger des Servers bestätigt',
  draftDiskNotSaved: 'Der Server meldet, dass dieser Entwurf nicht auf seinem Datenträger gespeichert ist',
  draftDiskUnknown: 'Speicherung auf dem Server-Datenträger nicht bestätigt',
  draftsMemoryOnlyNotice:
    'Dieses Gerät konnte diese Entwürfe nicht speichern: Nur dieses Fenster enthält sie. Kopieren Sie sie jetzt.',
  draftServerUnconfirmed:
    'Entwurf an den Server gesendet, Speicherung auf dessen Datenträger noch nicht bestätigt; auf diesem Gerät gespeichert',
  draftsDiscard: 'Entwürfe verwerfen',
  draftNotSavedOwner:
    'Nicht gespeichert: Dieses Formular konnte nicht bestätigen, zu welcher Unterhaltung es gehört. Kopieren Sie Ihren Text, bevor das Formular schließt.',
  draftServerOnly: 'Entwurf nur auf dem Server gespeichert: Dieses Gerät konnte keine Kopie speichern',
  draftNotSaved:
    'Nicht gespeichert: Dieses Gerät konnte Ihre letzten Änderungen nicht speichern, und der Server hat sie nicht bestätigt. Kopieren Sie Ihren Text, bevor das Formular schließt.',
  draftNewerOnDevice: 'Neuer als die Fassung, die der Assistent erhalten hat',
  draftsRecall: 'Auf dem Server gespeicherte Entwürfe anzeigen',
  draftsRecalling: 'Gespeicherte Entwürfe werden gelesen…',
  draftsRecallUnavailable:
    'Dieser Server kann gespeicherte Entwürfe nicht abrufen. Nur eine Kopie auf diesem Gerät kann angezeigt werden.',
  draftsRecallFailed:
    'Die auf dem Server gespeicherten Entwürfe konnten nicht gelesen werden. Versuchen Sie es erneut, sobald eine Verbindung besteht.',
  draftsRecallNone: 'Der Server hat keine gespeicherten Entwürfe für dieses Formular.',
  draftsListNotice:
    'Auf dem Server gespeicherte Entwürfe dieser Unterhaltung, neueste zuerst. Sie sind diesem Formular nicht zugeordnet: Prüfen Sie die Fragen, bevor Sie sie verwenden.',
  draftsListNone: 'Der Server hat keine gespeicherten Entwürfe für diese Unterhaltung.',
  draftsDiscarding: 'Entwürfe werden verworfen…',
  draftsDiscarded: (device: boolean, server: string) => {
    const here = device ? 'Von diesem Gerät entfernt' : 'Auf diesem Gerät war nichts gespeichert'

    if (server === 'removed') {
      return device ? 'Von diesem Gerät und vom Server entfernt.' : 'Vom Server entfernt.'
    }

    if (server === 'missing') {
      return `${here}; der Server hatte keine Kopie.`
    }

    if (server === 'unsupported') {
      return `${here}. Dieser Server kann gespeicherte Entwürfe nicht entfernen, daher bleibt eine dortige Kopie erhalten.`
    }

    return server === 'unreachable'
      ? `${here}. Der Server war nicht erreichbar, daher bleibt eine dortige Kopie erhalten.`
      : `${here}, aber die Kopie konnte nicht vom Server entfernt werden: Sie kann dort weiterhin abgerufen werden.`
  }
}
