import {
  DB_NAME, DB_VERSION, STORE_NAMES, DatabaseError, readAllData, replaceAllData, mergeAllData,
} from "./db.js";

export const BACKUP_FORMAT = "FISIO_IF_BACKUP";
export const BACKUP_FORMAT_VERSION = 1;
export const MAX_BACKUP_BYTES = 100 * 1024 * 1024;
export const MAX_BACKUP_RECORDS = 250_000;

export class BackupError extends Error {
  constructor(message, { code = "BACKUP_ERROR", cause, details } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "BackupError";
    this.code = code;
    this.details = details;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableCopy(value) {
  if (Array.isArray(value)) return value.map(stableCopy);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().filter(
    (key) => value[key] !== undefined,
  ).map((key) => [key, stableCopy(value[key])]));
}

function contentWithoutChecksum(backup) {
  return Object.fromEntries(Object.entries(backup).filter(([key]) => key !== "checksum"));
}

function canonicalBackupText(backup) {
  return JSON.stringify(stableCopy(contentWithoutChecksum(backup)));
}

async function sha256(text) {
  if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") return null;
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Calcula o SHA-256 canónico, excluindo o próprio campo `checksum`. */
export function calculateBackupChecksum(backup) {
  return sha256(canonicalBackupText(backup));
}

function cloneJson(value) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch (cause) {
    throw new BackupError("A cópia de segurança contém valores inválidos.", {
      code: "INVALID_JSON_VALUE", cause,
    });
  }
}

async function blobText(blob) {
  if (typeof blob.text === "function") return blob.text();
  if (typeof FileReader === "undefined") {
    throw new BackupError("Este navegador não consegue ler o ficheiro selecionado.", {
      code: "FILE_READ_UNAVAILABLE",
    });
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new BackupError("Não foi possível ler o ficheiro.", {
      code: "FILE_READ_FAILED", cause: reader.error,
    }));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob, "utf-8");
  });
}

/** Aceita File/Blob, texto JSON, ArrayBuffer ou um objeto já analisado. */
export async function parseBackup(input) {
  if (isPlainObject(input)) return cloneJson(input);
  let text;
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    if (input.size > MAX_BACKUP_BYTES) throw new BackupError(
      "O ficheiro é demasiado grande para ser uma cópia de segurança válida.",
      { code: "FILE_TOO_LARGE", details: { size: input.size, maximum: MAX_BACKUP_BYTES } },
    );
    try { text = await blobText(input); }
    catch (cause) {
      if (cause instanceof BackupError) throw cause;
      throw new BackupError("Não foi possível ler o ficheiro selecionado.", {
        code: "FILE_READ_FAILED", cause,
      });
    }
  } else if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    const bytes = input instanceof ArrayBuffer
      ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (bytes.byteLength > MAX_BACKUP_BYTES) throw new BackupError(
      "O ficheiro é demasiado grande para ser uma cópia de segurança válida.",
      { code: "FILE_TOO_LARGE" },
    );
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (cause) {
      throw new BackupError("O ficheiro não usa uma codificação de texto válida.", {
        code: "INVALID_ENCODING", cause,
      });
    }
  } else if (typeof input === "string") text = input;
  else throw new BackupError("Selecione um ficheiro de cópia de segurança JSON.", {
    code: "UNSUPPORTED_INPUT",
  });

  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) {
    throw new BackupError("O ficheiro é demasiado grande para ser importado.", { code: "FILE_TOO_LARGE" });
  }
  const cleanText = text.replace(/^\uFEFF/, "").trim();
  if (!cleanText) throw new BackupError("O ficheiro selecionado está vazio.", { code: "EMPTY_FILE" });
  try {
    const parsed = JSON.parse(cleanText);
    if (!isPlainObject(parsed)) throw new TypeError("raiz não é um objeto");
    return parsed;
  } catch (cause) {
    throw new BackupError("O ficheiro não contém JSON válido da FISIO IF.", {
      code: "INVALID_JSON", cause,
    });
  }
}

/** Produz um objeto integral, portátil e opcionalmente protegido por SHA-256. */
export async function createBackup({ appVersion = "1.0.0" } = {}) {
  const data = await readAllData();
  const backup = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: DB_VERSION,
    appVersion,
    createdAt: new Date().toISOString(),
    source: { database: DB_NAME },
    stats: Object.fromEntries(STORE_NAMES.map((name) => [name, data[name].length])),
    data,
  };
  const value = await calculateBackupChecksum(backup).catch(() => null);
  return { ...backup, checksum: value ? { algorithm: "SHA-256", value } : null };
}

function recordKey(storeName, record) {
  return storeName === "settings" ? record.key : record.id;
}

function reportDateWarning(storeName, record, warnings) {
  for (const field of ["createdAt", "updatedAt"]) {
    if (record[field] != null && !Number.isFinite(Date.parse(record[field]))) {
      warnings.push(`${storeName}: o registo ${recordKey(storeName, record)} tem ${field} inválido.`);
    }
  }
}

/**
 * Valida estrutura, chaves duplicadas, relações e checksum. Não altera a base.
 * Devolve sempre um relatório; `valid` determina se o restauro é seguro.
 */
export async function validateBackup(input, { verifyChecksum = true } = {}) {
  let backup;
  try { backup = await parseBackup(input); }
  catch (error) {
    return { valid: false, errors: [error.message], warnings: [], backup: null, summary: null };
  }

  const errors = [];
  const warnings = [];
  if (backup.format !== BACKUP_FORMAT) errors.push("O ficheiro não é uma cópia FISIO IF reconhecida.");
  if (!Number.isInteger(backup.formatVersion) || backup.formatVersion < 1) {
    errors.push("A versão do formato da cópia não é válida.");
  } else if (backup.formatVersion > BACKUP_FORMAT_VERSION) {
    errors.push("A cópia foi criada por uma versão mais recente da aplicação.");
  }
  if (!Number.isInteger(backup.schemaVersion) || backup.schemaVersion < 1) {
    errors.push("A versão da base de dados da cópia não é válida.");
  } else if (backup.schemaVersion > DB_VERSION) {
    errors.push("A base da cópia é mais recente e não pode ser restaurada com segurança.");
  } else if (backup.schemaVersion < DB_VERSION) {
    warnings.push("A cópia usa um esquema antigo; os dados serão atualizados ao restaurar.");
  }
  if (!Number.isFinite(Date.parse(backup.createdAt))) warnings.push("A data de criação da cópia é inválida.");
  if (!isPlainObject(backup.data)) errors.push("A cópia não contém um bloco de dados válido.");

  const normalisedData = {};
  let totalRecords = 0;
  for (const storeName of STORE_NAMES) {
    const records = backup.data?.[storeName];
    if (!Array.isArray(records)) {
      if (storeName === "packages" && Number(backup.schemaVersion) < 2) {
        warnings.push("A cópia é anterior à gestão de pacotes; será restaurada sem pacotes.");
      } else {
        errors.push(`A coleção ${storeName} está ausente ou danificada.`);
      }
      normalisedData[storeName] = [];
      continue;
    }
    totalRecords += records.length;
    const seen = new Set();
    normalisedData[storeName] = [];
    records.forEach((record, index) => {
      if (!isPlainObject(record)) {
        errors.push(`${storeName}: o registo ${index + 1} não é um objeto válido.`);
        return;
      }
      const key = recordKey(storeName, record);
      if (typeof key !== "string" || !key.trim()) {
        errors.push(`${storeName}: o registo ${index + 1} não tem uma chave válida.`);
        return;
      }
      if (seen.has(key)) errors.push(`${storeName}: a chave ${key} está duplicada.`);
      seen.add(key);
      try { normalisedData[storeName].push(cloneJson(record)); }
      catch (error) { errors.push(`${storeName}: ${error.message}`); }
      reportDateWarning(storeName, record, warnings);
    });
    if (backup.stats?.[storeName] != null && backup.stats[storeName] !== records.length) {
      warnings.push(`${storeName}: a contagem declarada não corresponde aos dados.`);
    }
  }
  if (totalRecords > MAX_BACKUP_RECORDS) {
    errors.push(`A cópia excede o limite de ${MAX_BACKUP_RECORDS} registos.`);
  }

  const patientIds = new Set(normalisedData.patients.map((record) => record.id));
  for (const storeName of ["appointments", "packages", "sessions", "evaluations", "transactions"]) {
    for (const record of normalisedData[storeName]) {
      if (record.patientId && !patientIds.has(record.patientId)) {
        errors.push(`${storeName}: o registo ${record.id} refere um paciente inexistente.`);
      } else if (!record.patientId && storeName !== "transactions") {
        warnings.push(`${storeName}: o registo ${record.id} não está associado a um paciente.`);
      }
    }
  }

  const packages = new Map(normalisedData.packages.map((record) => [record.id, record]));
  for (const item of normalisedData.packages) {
    if (!Number.isInteger(Number(item.totalSessions)) || Number(item.totalSessions) < 1) {
      errors.push(`packages: o pacote ${item.id} não tem um número de sessões válido.`);
    }
    if (!Number.isFinite(Number(item.pricePerSession)) || Number(item.pricePerSession) < 0) {
      errors.push(`packages: o pacote ${item.id} não tem um preço por sessão válido.`);
    }
  }
  for (const item of normalisedData.sessions) {
    if (!item.packageId) continue;
    const packageRecord = packages.get(item.packageId);
    if (!packageRecord) errors.push(`sessions: a sessão ${item.id} refere um pacote inexistente.`);
    else if (packageRecord.patientId !== item.patientId) {
      errors.push(`sessions: a sessão ${item.id} e o respetivo pacote pertencem a pacientes diferentes.`);
    }
  }
  for (const item of normalisedData.transactions) {
    if (item.packageId && !packages.has(item.packageId)) {
      errors.push(`transactions: o movimento ${item.id} refere um pacote inexistente.`);
    }
  }

  if (verifyChecksum) {
    if (!backup.checksum) warnings.push("A cópia não inclui checksum de integridade.");
    else if (backup.checksum.algorithm !== "SHA-256" ||
      !/^[a-f0-9]{64}$/i.test(backup.checksum.value || "")) {
      errors.push("O checksum da cópia não é válido.");
    } else {
      try {
        const actual = await calculateBackupChecksum(backup);
        if (actual == null) warnings.push("Este navegador não permite verificar o checksum.");
        else if (actual.toLowerCase() !== backup.checksum.value.toLowerCase()) {
          errors.push("O checksum não corresponde: o ficheiro pode estar alterado ou incompleto.");
        }
      } catch {
        warnings.push("Não foi possível verificar o checksum neste dispositivo.");
      }
    }
  }

  const normalised = { ...backup, data: normalisedData };
  return {
    valid: errors.length === 0,
    errors,
    warnings: [...new Set(warnings)],
    backup: normalised,
    summary: {
      createdAt: backup.createdAt || null,
      schemaVersion: backup.schemaVersion ?? null,
      totalRecords,
      counts: Object.fromEntries(STORE_NAMES.map((name) => [name, normalisedData[name].length])),
    },
  };
}

function storeKeySet(storeName, records) {
  return new Set(records.map((record) => recordKey(storeName, record)));
}

function replaceChanges(storeName, before, incoming) {
  const oldKeys = storeKeySet(storeName, before);
  const newKeys = storeKeySet(storeName, incoming);
  let shared = 0;
  for (const key of newKeys) if (oldKeys.has(key)) shared += 1;
  return {
    received: incoming.length,
    before: before.length,
    inserted: incoming.length - shared,
    updated: shared,
    skipped: 0,
    removed: before.length - shared,
    after: incoming.length,
  };
}

function recordTime(record) {
  for (const field of ["updatedAt", "modifiedAt", "createdAt"]) {
    const value = Date.parse(record?.[field]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function previewMerge(storeName, before, incoming, conflict) {
  const local = new Map(before.map((record) => [recordKey(storeName, record), record]));
  const result = { inserted: 0, updated: 0, skipped: 0 };
  for (const record of incoming) {
    const current = local.get(recordKey(storeName, record));
    if (!current) { result.inserted += 1; continue; }
    if (conflict === "local") { result.skipped += 1; continue; }
    if (conflict === "incoming") { result.updated += 1; continue; }
    const currentTime = recordTime(current);
    const incomingTime = recordTime(record);
    const wins = (incomingTime == null && currentTime == null) ||
      (incomingTime != null && currentTime == null) ||
      (incomingTime != null && currentTime != null && incomingTime >= currentTime);
    result[wins ? "updated" : "skipped"] += 1;
  }
  return result;
}

/** Restauro atómico em modo `replace` ou `merge`; `dryRun` apenas simula. */
export async function restoreBackup(input, {
  mode = "replace", conflict = "newer", verifyChecksum = true,
  preserveLocalSettings = false, dryRun = false,
} = {}) {
  if (!['replace', 'merge'].includes(mode)) throw new BackupError(
    "Escolha um modo de restauro válido (substituir ou combinar).", { code: "INVALID_RESTORE_MODE" },
  );
  if (mode === "merge" && !["newer", "incoming", "local"].includes(conflict)) {
    throw new BackupError("A regra de conflito escolhida não é válida.", {
      code: "INVALID_CONFLICT_POLICY",
    });
  }
  const validation = await validateBackup(input, { verifyChecksum });
  if (!validation.valid) throw new BackupError(
    `A cópia não pode ser restaurada: ${validation.errors.join(" ")}`,
    { code: "INVALID_BACKUP", details: validation },
  );

  const startedAt = new Date().toISOString();
  const before = await readAllData();
  const data = cloneJson(validation.backup.data);
  if (preserveLocalSettings) {
    const incoming = new Map(data.settings.map((record) => [record.key, record]));
    for (const record of before.settings) incoming.set(record.key, record);
    data.settings = [...incoming.values()];
  }

  let operation = dryRun && mode === "merge"
    ? Object.fromEntries(STORE_NAMES.map((name) => [
      name, previewMerge(name, before[name], data[name], conflict),
    ]))
    : null;
  if (!dryRun) {
    try {
      operation = mode === "replace"
        ? await replaceAllData(data)
        : await mergeAllData(data, { conflict });
    } catch (cause) {
      const message = cause instanceof DatabaseError ? cause.message : "O restauro dos dados falhou.";
      throw new BackupError(message, { code: "RESTORE_FAILED", cause });
    }
  }

  const after = dryRun ? before : await readAllData();
  const changes = Object.fromEntries(STORE_NAMES.map((name) => {
    if (mode === "replace") return [name, replaceChanges(name, before[name], data[name])];
    const result = operation?.[name] || { inserted: 0, updated: 0, skipped: 0 };
    return [name, {
      received: data[name].length,
      before: before[name].length,
      ...result,
      removed: 0,
      after: dryRun ? before[name].length + result.inserted : after[name].length,
    }];
  }));
  const totals = Object.values(changes).reduce((sum, value) => ({
    inserted: sum.inserted + value.inserted,
    updated: sum.updated + value.updated,
    skipped: sum.skipped + value.skipped,
    removed: sum.removed + value.removed,
  }), { inserted: 0, updated: 0, skipped: 0, removed: 0 });

  return {
    ok: true,
    dryRun,
    mode,
    conflict: mode === "merge" ? conflict : null,
    backupCreatedAt: validation.backup.createdAt,
    startedAt,
    finishedAt: new Date().toISOString(),
    changes,
    totals,
    warnings: validation.warnings,
  };
}

export function serializeBackup(backup, { pretty = true } = {}) {
  return JSON.stringify(backup, null, pretty ? 2 : 0);
}

export function createBackupFileName(date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  return `fisio-if-backup-${stamp}.json`;
}

/** Abre a partilha nativa quando possível; caso contrário inicia uma transferência. */
export async function shareOrDownloadBackup({
  backup, filename = createBackupFileName(), pretty = true, preferShare = true,
} = {}) {
  const content = backup || await createBackup();
  const blob = new Blob([serializeBackup(content, { pretty })], {
    type: "application/json;charset=utf-8",
  });
  if (preferShare && typeof File !== "undefined" && globalThis.navigator?.share) {
    const file = new File([blob], filename, { type: blob.type, lastModified: Date.now() });
    const shareData = { title: "Cópia de segurança FISIO IF", files: [file] };
    if (!navigator.canShare || navigator.canShare(shareData)) {
      try {
        await navigator.share(shareData);
        return { ok: true, method: "share", filename, bytes: blob.size };
      } catch (error) {
        if (error?.name === "AbortError") return { ok: false, method: "cancelled", filename };
      }
    }
  }
  if (typeof document === "undefined" || !globalThis.URL?.createObjectURL) {
    throw new BackupError("Este ambiente não permite guardar o ficheiro automaticamente.", {
      code: "DOWNLOAD_UNAVAILABLE",
    });
  }
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
  return { ok: true, method: "download", filename, bytes: blob.size };
}

export const downloadBackup = shareOrDownloadBackup;


