/** IndexedDB persistence for the offline FISIO IF PWA. */
export const DB_NAME = "fisio-if";
export const DB_VERSION = 2;
export const STORE_NAMES = Object.freeze([
  "patients", "appointments", "packages", "sessions", "evaluations", "transactions", "settings",
]);

const CONFIG = Object.freeze({
  patients: { keyPath: "id", indexes: [
    ["by_name", "sortName"], ["by_updatedAt", "updatedAt"],
  ] },
  appointments: { keyPath: "id", indexes: [
    ["by_patientId", "patientId"], ["by_start", "start"], ["by_status", "status"],
    ["by_patient_start", ["patientId", "start"]],
  ] },
  packages: { keyPath: "id", indexes: [
    ["by_patientId", "patientId"], ["by_purchaseDate", "purchaseDate"],
    ["by_patient_purchaseDate", ["patientId", "purchaseDate"]],
  ] },
  sessions: { keyPath: "id", indexes: [
    ["by_patientId", "patientId"], ["by_packageId", "packageId"], ["by_date", "date"],
    ["by_patient_date", ["patientId", "date"]],
  ] },
  evaluations: { keyPath: "id", indexes: [
    ["by_patientId", "patientId"], ["by_date", "date"],
    ["by_patient_date", ["patientId", "date"]],
  ] },
  transactions: { keyPath: "id", indexes: [
    ["by_patientId", "patientId"], ["by_packageId", "packageId"], ["by_date", "date"], ["by_type", "type"],
    ["by_status", "status"], ["by_patient_date", ["patientId", "date"]],
  ] },
  settings: { keyPath: "key", indexes: [["by_updatedAt", "updatedAt"]] },
});

const DEPENDENT_STORES = Object.freeze([
  "appointments", "packages", "sessions", "evaluations", "transactions",
]);
const listeners = new Set();
let databasePromise = null;

export class DatabaseError extends Error {
  constructor(message, { code = "DB_ERROR", cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "DatabaseError";
    this.code = code;
  }
}

function emit(type, detail = {}) {
  for (const listener of listeners) {
    try { listener({ type, detail }); }
    catch (error) { console.error("Erro num observador da base de dados:", error); }
  }
}

/** Recebe eventos `blocked`, `versionchange` e `closed`. */
export function onDatabaseEvent(listener) {
  if (typeof listener !== "function") throw new TypeError("O observador tem de ser uma função.");
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function assertIndexedDB() {
  if (!globalThis.indexedDB) {
    throw new DatabaseError("Este navegador não disponibiliza armazenamento local IndexedDB.", {
      code: "INDEXEDDB_UNAVAILABLE",
    });
  }
}

function assertStore(storeName) {
  if (!STORE_NAMES.includes(storeName)) {
    throw new DatabaseError(`A coleção local "${storeName}" não existe.`, { code: "UNKNOWN_STORE" });
  }
}

function createOrUpdateSchema(database, transaction) {
  for (const [name, config] of Object.entries(CONFIG)) {
    const store = database.objectStoreNames.contains(name)
      ? transaction.objectStore(name)
      : database.createObjectStore(name, { keyPath: config.keyPath });
    for (const [indexName, keyPath] of config.indexes) {
      if (!store.indexNames.contains(indexName)) {
        store.createIndex(indexName, keyPath, { unique: false });
      }
    }
  }
  transaction.objectStore("settings").put({
    key: "__schema__", value: DB_VERSION, updatedAt: new Date().toISOString(),
  });
}

/** Abre a base e aplica migrações de esquema. */
export function openDatabase() {
  if (databasePromise) return databasePromise;
  assertIndexedDB();
  databasePromise = new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => createOrUpdateSchema(request.result, request.transaction);
    request.onblocked = () => emit("blocked", { version: DB_VERSION });
    request.onerror = () => {
      databasePromise = null;
      reject(new DatabaseError("Não foi possível abrir os dados locais da FISIO IF.", {
        code: "OPEN_FAILED", cause: request.error,
      }));
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = (event) => {
        database.close();
        databasePromise = null;
        emit("versionchange", { oldVersion: event.oldVersion, newVersion: event.newVersion });
      };
      database.onclose = () => { databasePromise = null; emit("closed"); };
      resolve(database);
    };
  });
  return databasePromise;
}

export const initDB = openDatabase;
export const dbReady = openDatabase;

export async function closeDatabase() {
  if (!databasePromise) return;
  try { (await databasePromise).close(); }
  finally { databasePromise = null; }
}

function requestResult(request, message = "A operação local falhou.") {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new DatabaseError(message, {
      code: request.error?.name || "REQUEST_FAILED", cause: request.error,
    }));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(new DatabaseError(
      "A alteração aos dados locais foi cancelada.",
      { code: "TRANSACTION_ABORTED", cause: transaction.error },
    ));
    transaction.onerror = () => {};
  });
}

/** Executa operações na mesma transação atómica. */
export async function runTransaction(storeNames, mode, operation) {
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  names.forEach(assertStore);
  if (!names.length) throw new DatabaseError("A transação não indica nenhuma coleção.", {
    code: "EMPTY_TRANSACTION",
  });
  const database = await openDatabase();
  let transaction;
  try { transaction = database.transaction(names, mode); }
  catch (cause) {
    throw new DatabaseError("Não foi possível iniciar a operação local.", {
      code: "TRANSACTION_START_FAILED", cause,
    });
  }
  const done = transactionDone(transaction);
  const stores = Object.fromEntries(names.map((name) => [name, transaction.objectStore(name)]));
  try {
    const result = await operation(stores, transaction);
    await done;
    return result;
  } catch (error) {
    try { transaction.abort(); } catch {}
    try { await done; } catch {}
    if (error instanceof DatabaseError) throw error;
    throw new DatabaseError("A operação nos dados locais falhou.", {
      code: "TRANSACTION_FAILED", cause: error,
    });
  }
}

export function generateId(prefix = "") {
  const random = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return prefix ? `${prefix}_${random}` : random;
}

function cloneSerializable(value) {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError("valor vazio");
    return JSON.parse(json);
  } catch (cause) {
    throw new DatabaseError("Os dados contêm um valor que não pode ser guardado ou exportado.", {
      code: "NOT_SERIALIZABLE", cause,
    });
  }
}

function normaliseText(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim().toLocaleLowerCase("pt-PT");
}

function prepareRecord(storeName, record, { touch = true } = {}) {
  assertStore(storeName);
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new DatabaseError("O registo a guardar não é válido.", { code: "INVALID_RECORD" });
  }
  const prepared = cloneSerializable(record);
  const now = new Date().toISOString();
  const keyPath = CONFIG[storeName].keyPath;
  if (keyPath === "id") {
    prepared.id = String(prepared.id || generateId(storeName.slice(0, 3)));
    prepared.createdAt ||= now;
  } else if (!String(prepared[keyPath] ?? "").trim()) {
    throw new DatabaseError(`O registo de ${storeName} não tem a chave obrigatória.`, {
      code: "MISSING_KEY",
    });
  } else prepared[keyPath] = String(prepared[keyPath]);
  if (touch || !prepared.updatedAt) prepared.updatedAt = now;
  if (storeName === "patients") prepared.sortName = normaliseText(prepared.name);
  return prepared;
}

function keyPathFor(storeName) { assertStore(storeName); return CONFIG[storeName].keyPath; }

export async function add(storeName, record) {
  const prepared = prepareRecord(storeName, record);
  await runTransaction(storeName, "readwrite", (stores) => requestResult(
    stores[storeName].add(prepared),
    "Não foi possível adicionar o registo. Poderá já existir.",
  ));
  return prepared;
}

export async function upsert(storeName, record, { touch = true } = {}) {
  const prepared = prepareRecord(storeName, record, { touch });
  await runTransaction(storeName, "readwrite", (stores) => requestResult(
    stores[storeName].put(prepared), "Não foi possível guardar o registo.",
  ));
  return prepared;
}

export async function update(storeName, key, changes) {
  const keyPath = keyPathFor(storeName);
  return runTransaction(storeName, "readwrite", async (stores) => {
    const store = stores[storeName];
    const current = await requestResult(store.get(key), "Não foi possível consultar o registo.");
    if (!current) throw new DatabaseError("O registo que tentou alterar já não existe.", {
      code: "NOT_FOUND",
    });
    const prepared = prepareRecord(storeName, {
      ...current, ...changes, [keyPath]: current[keyPath], createdAt: current.createdAt,
    });
    await requestResult(store.put(prepared), "Não foi possível alterar o registo.");
    return prepared;
  });
}

export function getById(storeName, key) {
  return runTransaction(storeName, "readonly", (stores) => requestResult(
    stores[storeName].get(key), "Não foi possível consultar o registo.",
  ));
}

function indexedSource(store, indexName) {
  if (!store.indexNames.contains(indexName)) {
    throw new DatabaseError(`O índice local "${indexName}" não existe.`, { code: "UNKNOWN_INDEX" });
  }
  return store.index(indexName);
}

function collectCursor(source, query, { direction = "next", offset = 0, limit } = {}) {
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = limit == null ? Infinity : Math.max(0, Number(limit) || 0);
  if (safeLimit === 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const values = [];
    let skipped = 0;
    const request = source.openCursor(query ?? null, direction);
    request.onerror = () => reject(new DatabaseError("Não foi possível listar os registos locais.", {
      code: request.error?.name || "CURSOR_FAILED", cause: request.error,
    }));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || values.length >= safeLimit) { resolve(values); return; }
      if (skipped < safeOffset) skipped += 1;
      else values.push(cursor.value);
      cursor.continue();
    };
  });
}

/** Lista registos, opcionalmente através de um índice. */
export function getAll(storeName, {
  index, query = null, direction = "next", offset = 0, limit,
} = {}) {
  return runTransaction(storeName, "readonly", (stores) => {
    const source = index ? indexedSource(stores[storeName], index) : stores[storeName];
    return collectCursor(source, query, { direction, offset, limit });
  });
}

export function queryByIndex(storeName, index, query, options = {}) {
  return getAll(storeName, { ...options, index, query });
}

export function getAllKeys(storeName) {
  return runTransaction(storeName, "readonly", (stores) => requestResult(
    stores[storeName].getAllKeys(), "Não foi possível consultar as chaves locais.",
  ));
}

export function count(storeName, { index, query } = {}) {
  return runTransaction(storeName, "readonly", (stores) => {
    const source = index ? indexedSource(stores[storeName], index) : stores[storeName];
    const request = query === undefined || query === null ? source.count() : source.count(query);
    return requestResult(request, "Não foi possível contar os registos.");
  });
}

export async function remove(storeName, key) {
  const existed = await getById(storeName, key);
  if (!existed) return false;
  await runTransaction(storeName, "readwrite", (stores) => requestResult(
    stores[storeName].delete(key), "Não foi possível eliminar o registo.",
  ));
  return true;
}

export async function bulkUpsert(storeName, records, { touch = false } = {}) {
  if (!Array.isArray(records)) throw new DatabaseError(
    "O conjunto de registos a guardar não é válido.", { code: "INVALID_RECORD_SET" },
  );
  const prepared = records.map((record) => prepareRecord(storeName, record, { touch }));
  await runTransaction(storeName, "readwrite", (stores) => Promise.all(
    prepared.map((record) => requestResult(
      stores[storeName].put(record), "Não foi possível guardar um dos registos.",
    )),
  ));
  return prepared;
}

function deleteIndexMatches(store, indexName, query) {
  return new Promise((resolve, reject) => {
    let deleted = 0;
    const request = indexedSource(store, indexName).openCursor(query);
    request.onerror = () => reject(new DatabaseError("Não foi possível eliminar os dados associados.", {
      code: request.error?.name || "CASCADE_DELETE_FAILED", cause: request.error,
    }));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(deleted); return; }
      cursor.delete();
      deleted += 1;
      cursor.continue();
    };
  });
}

/** Elimina o paciente e, por omissão, todos os respetivos registos. */
export async function deletePatient(patientId, { cascade = true } = {}) {
  const id = String(patientId ?? "").trim();
  if (!id) throw new DatabaseError("Não foi indicado o paciente a eliminar.", {
    code: "MISSING_PATIENT_ID",
  });
  const names = ["patients", ...DEPENDENT_STORES];
  return runTransaction(names, "readwrite", async (stores) => {
    const patient = await requestResult(stores.patients.get(id));
    const deleted = Object.fromEntries(names.map((name) => [name, 0]));
    if (!patient) return { found: false, deleted };
    if (!cascade) {
      const totals = await Promise.all(DEPENDENT_STORES.map((name) => requestResult(
        indexedSource(stores[name], "by_patientId").count(id),
      )));
      if (totals.some(Boolean)) throw new DatabaseError(
        "O paciente tem sessões ou outros registos associados. Confirme a eliminação integral.",
        { code: "PATIENT_HAS_DEPENDENCIES" },
      );
    } else {
      const totals = await Promise.all(DEPENDENT_STORES.map((name) =>
        deleteIndexMatches(stores[name], "by_patientId", id),
      ));
      DEPENDENT_STORES.forEach((name, index) => { deleted[name] = totals[index]; });
    }
    await requestResult(stores.patients.delete(id));
    deleted.patients = 1;
    return { found: true, deleted };
  });
}

/** Limpa os dados funcionais; pode conservar preferências locais. */
export async function clearAllData({ preserveSettings = false } = {}) {
  const names = preserveSettings ? STORE_NAMES.filter((name) => name !== "settings") : [...STORE_NAMES];
  await runTransaction(names, "readwrite", (stores) => Promise.all(
    names.map((name) => requestResult(stores[name].clear(), `Não foi possível limpar ${name}.`)),
  ));
  if (!preserveSettings) await upsert("settings", { key: "__schema__", value: DB_VERSION });
  return Object.fromEntries(names.map((name) => [name, true]));
}

/** Lê todas as coleções na mesma transação para um retrato consistente. */
export function readAllData() {
  return runTransaction(STORE_NAMES, "readonly", async (stores) => Object.fromEntries(
    await Promise.all(STORE_NAMES.map(async (name) => [
      name, await requestResult(stores[name].getAll(), `Não foi possível ler ${name}.`),
    ])),
  ));
}

function validateDataSet(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new DatabaseError("O conjunto de dados para restauro não é válido.", {
      code: "INVALID_DATA_SET",
    });
  }
  for (const name of STORE_NAMES) {
    if (!Array.isArray(data[name])) throw new DatabaseError(`A coleção ${name} não é válida.`, {
      code: "INVALID_DATA_SET",
    });
  }
}

/** Substitui todas as coleções numa única transação atómica. */
export async function replaceAllData(data) {
  validateDataSet(data);
  const prepared = Object.fromEntries(STORE_NAMES.map((name) => [
    name, data[name].map((record) => prepareRecord(name, record, { touch: false })),
  ]));
  await runTransaction(STORE_NAMES, "readwrite", (stores) => {
    const requests = [];
    for (const name of STORE_NAMES) {
      requests.push(requestResult(stores[name].clear()));
      for (const record of prepared[name]) requests.push(requestResult(stores[name].put(record)));
    }
    return Promise.all(requests);
  });
  return Object.fromEntries(STORE_NAMES.map((name) => [name, prepared[name].length]));
}

function modifiedTime(record) {
  for (const field of ["updatedAt", "modifiedAt", "createdAt"]) {
    const time = Date.parse(record?.[field]);
    if (Number.isFinite(time)) return time;
  }
  return null;
}

function useIncoming(local, incoming, conflict) {
  if (conflict === "incoming") return true;
  if (conflict === "local") return false;
  const localTime = modifiedTime(local);
  const incomingTime = modifiedTime(incoming);
  if (incomingTime == null && localTime != null) return false;
  if (incomingTime != null && localTime == null) return true;
  if (incomingTime == null) return true;
  return incomingTime >= localTime;
}

/** Combina dados de forma atómica; conflitos: `newer`, `incoming` ou `local`. */
export async function mergeAllData(data, { conflict = "newer" } = {}) {
  validateDataSet(data);
  if (!["newer", "incoming", "local"].includes(conflict)) {
    throw new DatabaseError("A regra de conflito escolhida não é válida.", {
      code: "INVALID_CONFLICT_POLICY",
    });
  }
  const prepared = Object.fromEntries(STORE_NAMES.map((name) => [
    name, data[name].map((record) => prepareRecord(name, record, { touch: false })),
  ]));
  const result = Object.fromEntries(STORE_NAMES.map((name) => [
    name, { inserted: 0, updated: 0, skipped: 0 },
  ]));
  await runTransaction(STORE_NAMES, "readwrite", (stores) => {
    const operations = [];
    for (const name of STORE_NAMES) {
      const keyPath = CONFIG[name].keyPath;
      for (const incoming of prepared[name]) {
        operations.push(new Promise((resolve, reject) => {
          const getRequest = stores[name].get(incoming[keyPath]);
          getRequest.onerror = () => reject(getRequest.error);
          getRequest.onsuccess = () => {
            const local = getRequest.result;
            if (local && !useIncoming(local, incoming, conflict)) {
              result[name].skipped += 1;
              resolve();
              return;
            }
            const putRequest = stores[name].put(incoming);
            putRequest.onerror = () => reject(putRequest.error);
            putRequest.onsuccess = () => {
              result[name][local ? "updated" : "inserted"] += 1;
              resolve();
            };
          };
        }));
      }
    }
    return Promise.all(operations);
  });
  return result;
}

export async function getDatabaseInfo() {
  const counts = Object.fromEntries(await Promise.all(
    STORE_NAMES.map(async (name) => [name, await count(name)]),
  ));
  return { name: DB_NAME, version: DB_VERSION, stores: [...STORE_NAMES], counts };
}

export async function getSetting(key, fallback = undefined) {
  const record = await getById("settings", key);
  return record ? record.value : fallback;
}

export async function setSetting(key, value) {
  const record = await upsert("settings", { key, value });
  return record.value;
}

export function removeSetting(key) { return remove("settings", key); }

export async function getPatientSummary(patientId) {
  const [patient, ...totals] = await Promise.all([
    getById("patients", patientId),
    ...DEPENDENT_STORES.map((name) => count(name, { index: "by_patientId", query: patientId })),
  ]);
  return {
    patient,
    counts: Object.fromEntries(DEPENDENT_STORES.map((name, index) => [name, totals[index]])),
  };
}

/** Repositórios convenientes para a interface. */
export const repositories = Object.freeze(Object.fromEntries(STORE_NAMES.map((storeName) => [
  storeName,
  Object.freeze({
    add: (record) => add(storeName, record),
    save: (record, options) => upsert(storeName, record, options),
    update: (key, changes) => update(storeName, key, changes),
    get: (key) => getById(storeName, key),
    list: (options) => getAll(storeName, options),
    count: (options) => count(storeName, options),
    remove: (key) => remove(storeName, key),
  }),
])));


