// Single source of truth for the document accuracy disclaimers shown at upload
// and at download. ServiceCycle is a storage / data-extraction / alerting
// platform; it does not author or verify customer-uploaded files. Keep this
// wording in sync across every upload form and download gate (asset card,
// document library, and the field-mode copy in pages/field/FieldAsset.jsx).
// NOTE: PE / legal counsel should bless the final text before launch.

export const UPLOAD_DISCLAIMER =
  'ServiceCycle is a storage, data-extraction, and alerting platform. Documents, test reports, and files are produced by you, your contractors, or your equipment vendors - not by ServiceCycle. We store them and extract data for tracking and alerts; we do not author, review, verify, certify, or guarantee the accuracy, completeness, or currency of any uploaded file or the data derived from it. You remain responsible for verifying any document before relying on it for energized work, switching, de-energization, or compliance.';

export const DOWNLOAD_DISCLAIMER =
  'This file was uploaded by your organization or its contractors. ServiceCycle stores and displays it but does not author or verify it, and does not guarantee its accuracy or currency. Confirm it is current (and where required, professionally sealed) before relying on it for switching, de-energization, or LOTO.';
