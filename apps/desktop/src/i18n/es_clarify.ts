import type { ClarifyCopy } from './types_clarify'

export const esClarify: Partial<ClarifyCopy> = {
  notReady: 'La solicitud de aclaración aún no está lista',
  gatewayDisconnected: 'Hermes está sin conexión ahora mismo. Reconéctate y vuelve a enviarlo.',
  sendFailed: 'No se pudo enviar la respuesta de aclaración',
  loadingQuestion: 'Cargando pregunta…',
  other: 'Otro (escribe tu respuesta)',
  placeholder: 'Escribe tu respuesta…',
  skip: 'Omitir',
  skipped: 'Omitido',
  noAnswer: 'Sin respuesta',
  confirmAndContinueLabel: 'Confirmar y continuar',
  singleSelectHint: 'Elige una',
  multiSelectHint: 'Elige todas las que correspondan',
  oneQuestion: '1 pregunta',
  questionProgress: (answered, total) => `${answered} de ${total} respondidas`,
  notDelivered:
    'Esta pregunta no llegó a la app, así que no se puede responder aquí. Pulsa Detener para terminar el turno y luego responde en el chat.',
  draftSaved: 'Borrador guardado',
  draftDeviceOnly: 'Borrador guardado solo en este dispositivo',
  draftServerUnavailable:
    'Guardado automático en el servidor no disponible: borrador guardado solo en este dispositivo',
  draftsHeading: 'Borradores no enviados',
  draftsAssistantNotice: 'Se informó al asistente de que son borradores, no respuestas.',
  draftsDeviceOnlyNotice: 'El asistente no ha visto estos borradores.',
  draftsContinue:
    'Este formulario se cerró y ya no se puede enviar. Copia los borradores en una respuesta para continuar.',
  draftsCopy: 'Copiar borradores',
  draftNotInTranscript: 'El asistente no ha visto este borrador',
  draftDiskConfirmed: 'Autoguardado confirmado: guardado en el disco del servidor',
  draftDiskNotSaved: 'El servidor indicó que este borrador no está guardado en su disco',
  draftDiskUnknown: 'Guardado en el disco del servidor sin confirmar',
  draftsMemoryOnlyNotice:
    'Este dispositivo no pudo guardar estos borradores: solo esta ventana los conserva. Cópialos ahora.',
  draftServerUnconfirmed: 'Borrador enviado al servidor, aún sin confirmar en su disco; guardado en este dispositivo',
  draftsDiscard: 'Descartar borradores',
  draftNotSavedOwner:
    'No guardado: este formulario no pudo confirmar a qué conversación pertenece. Copia tu texto antes de que se cierre.',
  draftServerOnly: 'Borrador guardado solo en el servidor: este dispositivo no pudo guardar una copia',
  draftNotSaved:
    'No guardado: este dispositivo no pudo guardar tus últimos cambios y el servidor no los ha confirmado. Copia tu texto antes de que se cierre el formulario.',
  draftNewerOnDevice: 'Más reciente que la copia que recibió el asistente',
  draftsRecall: 'Mostrar borradores guardados en el servidor',
  draftsRecalling: 'Leyendo borradores guardados…',
  draftsRecallUnavailable:
    'Este servidor no puede recuperar borradores guardados. Solo se puede mostrar una copia de este dispositivo.',
  draftsRecallFailed:
    'No se pudieron leer los borradores guardados en el servidor. Inténtalo de nuevo cuando haya conexión.',
  draftsRecallNone: 'El servidor no tiene borradores guardados de este formulario.',
  draftsListNotice:
    'Borradores guardados en el servidor para esta conversación, del más reciente al más antiguo. No están asociados a este formulario: revisa las preguntas antes de usarlos.',
  draftsListNone: 'El servidor no tiene borradores guardados de esta conversación.',
  draftsDiscarding: 'Descartando borradores…',
  draftsDiscarded: (device: boolean, server: string) => {
    const here = device ? 'Eliminado de este dispositivo' : 'No había nada guardado en este dispositivo'

    if (server === 'removed') {
      return device ? 'Eliminado de este dispositivo y del servidor.' : 'Eliminado del servidor.'
    }

    if (server === 'missing') {
      return `${here}; el servidor no tenía ninguna copia.`
    }

    if (server === 'unsupported') {
      return `${here}. Este servidor no puede eliminar borradores guardados, así que cualquier copia suya permanece.`
    }

    return server === 'unreachable'
      ? `${here}. No se pudo contactar con el servidor, así que cualquier copia suya permanece.`
      : `${here}, pero la copia no se pudo eliminar del servidor: todavía se puede recuperar allí.`
  }
}
