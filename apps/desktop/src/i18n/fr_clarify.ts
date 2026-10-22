import type { ClarifyCopy } from './types_clarify'

export const frClarify: Partial<ClarifyCopy> = {
  notReady: "La demande de clarification n'est pas encore prête",
  gatewayDisconnected: "La Gateway Hermes n'est pas connectée",
  sendFailed: "Impossible d'envoyer la réponse de clarification",
  loadingQuestion: 'Chargement de la question…',
  other: 'Autre (saisissez votre réponse)',
  placeholder: 'Saisissez votre réponse…',
  skip: 'Passer',
  skipped: 'Ignoré',
  noAnswer: 'Pas de réponse',
  confirmAndContinueLabel: 'Confirmer et continuer',
  singleSelectHint: 'Choisir une réponse',
  multiSelectHint: 'Choisir toutes les réponses qui s’appliquent',
  oneQuestion: '1 question',
  questionProgress: (answered, total) => `${answered} réponse${answered === 1 ? '' : 's'} sur ${total}`,
  notDelivered:
    "Cette question n'a pas atteint l'app, elle ne peut donc pas être répondue ici. Appuyez sur Arrêter pour terminer le tour, puis répondez dans le chat.",
  draftSaved: 'Brouillon enregistré',
  draftDeviceOnly: 'Brouillon conservé sur cet appareil uniquement',
  draftServerUnavailable:
    'Enregistrement automatique sur le serveur indisponible : brouillon conservé sur cet appareil uniquement',
  draftsHeading: 'Brouillons non envoyés',
  draftsAssistantNotice: 'L’assistant a été informé que ce sont des brouillons, pas des réponses.',
  draftsDeviceOnlyNotice: 'L’assistant n’a pas vu ces brouillons.',
  draftsContinue:
    'Ce formulaire est fermé et ne peut plus être envoyé. Copiez les brouillons dans une réponse pour continuer.',
  draftsCopy: 'Copier les brouillons',
  draftNotInTranscript: 'L’assistant n’a pas vu ce brouillon',
  draftDiskConfirmed: 'Enregistrement automatique confirmé sur le disque du serveur',
  draftDiskNotSaved: 'Le serveur indique que ce brouillon n’est pas enregistré sur son disque',
  draftDiskUnknown: 'Enregistrement sur le disque du serveur non confirmé',
  draftsMemoryOnlyNotice:
    'Cet appareil n’a pas pu stocker ces brouillons : seule cette fenêtre les contient. Copiez-les maintenant.',
  draftServerUnconfirmed: 'Brouillon envoyé au serveur, pas encore confirmé sur son disque ; conservé sur cet appareil',
  draftsDiscard: 'Supprimer les brouillons',
  draftNotSavedOwner:
    'Non enregistré : ce formulaire n’a pas pu confirmer à quelle conversation il appartient. Copiez votre texte avant sa fermeture.',
  draftServerOnly: 'Brouillon enregistré sur le serveur uniquement : cet appareil n’a pas pu en garder une copie',
  draftNotSaved:
    'Non enregistré : cet appareil n’a pas pu enregistrer vos dernières modifications et le serveur ne les a pas confirmées. Copiez votre texte avant la fermeture du formulaire.',
  draftNewerOnDevice: 'Plus récent que la copie transmise à l’assistant',
  draftsRecall: 'Afficher les brouillons enregistrés sur le serveur',
  draftsRecalling: 'Lecture des brouillons enregistrés…',
  draftsRecallUnavailable:
    'Ce serveur ne peut pas restituer les brouillons enregistrés. Seule une copie sur cet appareil peut être affichée.',
  draftsRecallFailed: 'Impossible de lire les brouillons enregistrés sur le serveur. Réessayez une fois connecté.',
  draftsRecallNone: 'Le serveur ne détient aucun brouillon pour ce formulaire.',
  draftsListNotice:
    'Brouillons enregistrés sur le serveur pour cette conversation, du plus récent au plus ancien. Ils ne sont pas associés à ce formulaire : vérifiez les questions avant de les utiliser.',
  draftsListNone: 'Le serveur ne détient aucun brouillon pour cette conversation.',
  draftsDiscarding: 'Suppression des brouillons…',
  draftsDiscarded: (device: boolean, server: string) => {
    const here = device ? 'Supprimé de cet appareil' : 'Rien n’était enregistré sur cet appareil'

    if (server === 'removed') {
      return device ? 'Supprimé de cet appareil et du serveur.' : 'Supprimé du serveur.'
    }

    if (server === 'missing') {
      return `${here} ; le serveur n’en détenait aucune copie.`
    }

    if (server === 'unsupported') {
      return `${here}. Ce serveur ne peut pas supprimer les brouillons enregistrés : toute copie qu’il détient reste.`
    }

    return server === 'unreachable'
      ? `${here}. Le serveur était injoignable : toute copie qu’il détient reste.`
      : `${here}, mais la copie n’a pas pu être supprimée du serveur : elle peut encore y être restituée.`
  }
}
