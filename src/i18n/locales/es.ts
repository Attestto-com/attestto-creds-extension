/**
 * Extension-local Spanish locale — stub for community translation.
 *
 * Keys mirror en.ts. Fill in translations as needed.
 */
export default {
  common: {
    cancel: 'Cancelar',
    back: 'Atr\u00e1s',
    copy: 'Copiar',
    copied: '\u00a1Copiado!',
    delete: 'Eliminar',
    share: 'Compartir',
    approve: 'Aprobar',
    decline: 'Rechazar',
    refresh: 'Actualizar',
    all: 'Todos',
    none: 'Ninguno',
    expired: 'Expirado',
    loading: 'Cargando...',
    error: 'Error',
    explorer: 'Explorador',
    unlink: 'Desvincular',
  },

  header: {
    tabs: {
      wallet: 'Billetera',
      credentials: 'Credenciales',
      settings: 'Ajustes',
    },
  },

  wallet: {
    unlocked: 'Billetera Desbloqueada',
    locked: 'Billetera Bloqueada',
    noDid: 'No se ha creado un DID a\u00fan',
    unlock: 'Desbloquear Billetera',
    createDid: 'Crear DID',
    lock: 'Bloquear',
    linkedSolana: 'Billetera Solana Vinculada',
    linkInstruction: 'Vincula tu billetera Solana desde la p\u00e1gina {page} en el panel de Attestto.',
    linkInstructionPage: 'Billetera de Identidad',
    linkInstructionDetail: 'Conecta tu billetera all\u00ed, luego usa "Vincular al Vault" para enviar la direcci\u00f3n aqu\u00ed.',
    tokens: 'Tokens',
    noTokens: 'No se encontraron tokens para esta billetera.',
  },

  credentials: {
    title: 'Credenciales Verificables',
    empty: {
      title: 'Sin Credenciales A\u00fan',
      description: 'Las credenciales verificables emitidas a tu billetera aparecer\u00e1n aqu\u00ed. Se pueden compartir con verificadores usando divulgaci\u00f3n selectiva.',
    },
    pendingRequests: '{count} solicitud(es) de prueba pendiente(s)',
    requestingAccess: '{name} est\u00e1 solicitando acceso',
    preparedReady: '{count} presentaci\u00f3n(es) preparada(s) lista(s)',
    deleteConfirm: {
      title: '\u00bfEliminar Credencial?',
      description: 'Esto eliminar\u00e1 permanentemente la credencial de tu billetera.',
    },
    issued: 'Emitido: {date}',
    expires: 'Expira: {date}',
    claims: '{count} atributo | {count} atributos',
    onChain: 'En Cadena',
    credential: 'Credencial',
  },

  present: {
    title: 'Presentar Credencial',
    selectClaims: 'Selecciona los atributos a revelar',
    allClaimsShared: 'Todos los atributos ser\u00e1n compartidos',
    nonce: 'Nonce (del verificador) *',
    noncePlaceholder: 'Ingresa el nonce del verificador',
    audience: 'Audiencia (ID del verificador)',
    audiencePlaceholder: 'Identificador opcional del verificador',
    preview: 'Vista previa de lo que se compartir\u00e1',
    hidePreview: 'Ocultar vista previa',
    sharedClaims: 'Atributos compartidos:',
    generate: 'Generar Presentaci\u00f3n',
    generating: 'Generando...',
    ready: 'Presentaci\u00f3n Lista',
    copyToClipboard: 'Copiar al Portapapeles',
    generateAnother: 'Generar Otra',
    walletKeyError: 'Clave de billetera no disponible',
    generationFailed: 'La generaci\u00f3n fall\u00f3',
  },

  consent: {
    title: 'Solicitud de Prueba',
    requestingAccess: '{name} est\u00e1 solicitando acceso',
    requestedFields: 'Campos Solicitados',
    presentationShared: 'Presentaci\u00f3n Compartida',
    fieldsDisclosed: '{count} campo(s) revelado(s) a {name}',
    requestDeclined: 'Solicitud Rechazada',
    noDataShared: 'No se compartieron datos con {name}',
    backToCredentials: 'Volver a Credenciales',
    transport: {
      didcomm: 'DIDComm v2 (P2P cifrado)',
      pushToVault: 'Enviar al Vault',
      platform: 'Plataforma Attestto',
    },
    disclosureNotice: 'Solo los campos seleccionados ser\u00e1n compartidos. Los dem\u00e1s datos de la credencial permanecen privados.',
  },

  prepared: {
    title: 'Presentaciones Preparadas',
    empty: {
      title: 'Sin presentaciones preparadas',
      description: 'Usa "Enviar al Vault" desde la p\u00e1gina de Compartir Credencial en Attestto para pre-construir presentaciones para uso posterior.',
    },
    remaining: '{time} restante',
    copyAndPresent: 'Copiar y Presentar',
    unknownCredential: 'Desconocido',
    verifiableCredential: 'Credencial Verificable',
  },

  settings: {
    title: 'Ajustes R\u00e1pidos',
    openFull: 'Abrir P\u00e1gina de Ajustes',
  },

  formats: {
    sdJwt: 'SD-JWT',
    jsonLd: 'JSON-LD',
    spl: 'SPL',
    token2022: 'Token-2022',
  },
}
