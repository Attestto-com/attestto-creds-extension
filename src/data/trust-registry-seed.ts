/**
 * Trust Registry seed — Costa Rica institutions.
 *
 * Sourced from `~/Attestto/1-research/datos-cr/cr-sector-publico.json`
 * (curated subset where `attestto_relevance.relevant === true`, 47 entries).
 *
 * This is a v0 SEED list, shipped with the extension. Future iterations
 * (ATT-630 follow-up) replace this with a runtime fetch against a public
 * trust-registry endpoint backed by the CORTEX ssi_trusted_entities table,
 * with this list as the offline / first-launch fallback.
 *
 * Brand-protection logic in `trust-registry.ts` derives the "brand label"
 * from each `host` — for `bccr.fi.cr` the brand is `bccr`. A candidate
 * domain whose brand label matches a registry brand but whose full host
 * does NOT match the registry entry is flagged as homograph-suspicious.
 *
 * To extend: append new entries here. Do not remove entries without
 * checking which canonical .sol namespaces / institutional pitches they
 * back (see `reference_did_webvh_overlap` + the .sol portfolio map).
 */

export interface RegistryEntry {
  /** Lowercased canonical host. URL.host of the institution's website. */
  host: string
  /** Short institution name shown in popup / verdict copy. */
  name: string
  /** Sector classification — for grouping in admin / settings views. */
  category: string
}

export const CR_SEED_REGISTRY: ReadonlyArray<RegistryEntry> = [
  { host: 'abogados.or.cr', name: 'CABAC', category: 'Derecho' },
  { host: 'bancobcr.com', name: 'BCR', category: 'Bancos Públicos' },
  { host: 'bccr.fi.cr', name: 'BCCR', category: 'Banco Central' },
  { host: 'bncr.fi.cr', name: 'BNCR', category: 'Bancos Públicos' },
  { host: 'bpdc.fi.cr', name: 'BPDC', category: 'Bancos Públicos' },
  { host: 'ccpcr.com', name: 'CCP', category: 'Contabilidad' },
  { host: 'ccss.sa.cr', name: 'CCSS', category: 'Instituciones Autónomas' },
  { host: 'cfia.or.cr', name: 'CFIA', category: 'Ingeniería y Arquitectura' },
  { host: 'colegiocienciaseconomicas.cr', name: 'CPCECR', category: 'Ciencias Económicas' },
  { host: 'colegiodentistascr.org', name: 'CCDCR', category: 'Ciencias Médicas' },
  { host: 'colfar.com', name: 'CFCR', category: 'Ciencias Médicas' },
  { host: 'conassif.fi.cr', name: 'CONASSIF', category: 'Órgano Rector' },
  { host: 'conesup.mep.go.cr', name: 'CONESUP', category: 'Regulación Universitaria Privada' },
  { host: 'cpic.or.cr', name: 'CPIC', category: 'Tecnologías de la Información' },
  { host: 'csirt.go.cr', name: 'CSIRT-CR', category: 'Ciberseguridad' },
  { host: 'csv.go.cr', name: 'COSEVI', category: 'Órganos Adscritos MOPT' },
  { host: 'enfermeras.or.cr', name: 'CECR', category: 'Ciencias Médicas' },
  { host: 'gobernacion.go.cr', name: 'MGPSP', category: 'Ministerios' },
  { host: 'grupoins.com', name: 'INS', category: 'Instituciones Autónomas' },
  { host: 'hacienda.go.cr', name: 'MH', category: 'Ministerios' },
  { host: 'icd.go.cr', name: 'ICD', category: 'Instituciones Autónomas' },
  { host: 'ict.go.cr', name: 'ICT', category: 'Instituciones Autónomas' },
  { host: 'imas.go.cr', name: 'IMAS', category: 'Instituciones Autónomas' },
  { host: 'medicos.cr', name: 'CMCR', category: 'Ciencias Médicas' },
  { host: 'meic.go.cr', name: 'MEIC', category: 'Ministerios' },
  { host: 'mep.go.cr', name: 'MEP', category: 'Ministerios' },
  { host: 'micitt.go.cr', name: 'DCFD', category: 'Firma Digital y PKI' },
  { host: 'migracion.go.cr', name: 'DGME', category: 'Órganos Adscritos' },
  { host: 'ministeriodesalud.go.cr', name: 'MINSA', category: 'Ministerios' },
  { host: 'mjp.go.cr', name: 'MJP', category: 'Ministerios' },
  { host: 'mopt.go.cr', name: 'MOPT', category: 'Ministerios' },
  { host: 'msj.go.cr', name: 'MSJ', category: 'Municipalidades - San José' },
  { host: 'oij.go.cr', name: 'OIJ', category: 'Poder Judicial' },
  { host: 'poder-judicial.go.cr', name: 'CSJ', category: 'Poder Judicial' },
  { host: 'registronacional.go.cr', name: 'RN', category: 'Registro Nacional' },
  { host: 'rree.go.cr', name: 'MREC', category: 'Ministerios' },
  { host: 'sinaes.ac.cr', name: 'SINAES', category: 'Acreditación' },
  { host: 'sinpe.fi.cr', name: 'CA-BNCR', category: 'Autoridades Certificadoras' },
  { host: 'sugef.fi.cr', name: 'SUGEF', category: 'Supervisores' },
  { host: 'sugeval.fi.cr', name: 'SUGEVAL', category: 'Supervisores' },
  { host: 'sutel.go.cr', name: 'SUTEL', category: 'Reguladores Servicios Públicos' },
  { host: 'tec.ac.cr', name: 'TEC', category: 'Universidades' },
  { host: 'tse.go.cr', name: 'RC', category: 'Registro Civil' },
  { host: 'ucr.ac.cr', name: 'UCR', category: 'Universidades' },
  { host: 'una.ac.cr', name: 'UNA', category: 'Universidades' },
  { host: 'uned.ac.cr', name: 'UNED', category: 'Universidades' },
  { host: 'utn.ac.cr', name: 'UTN', category: 'Universidades' },
] as const
