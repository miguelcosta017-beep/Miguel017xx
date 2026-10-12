const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const encoder = new TextEncoder();

const LABELS = Object.freeze({
  appointmentType: { session: "Sessão", assessment: "Avaliação", followup: "Reavaliação", other: "Outro" },
  appointmentStatus: { scheduled: "Agendada", confirmed: "Confirmada", completed: "Concluída", cancelled: "Cancelada", no_show: "Faltou" },
  paymentStatus: { pending: "Pendente", paid: "Pago", package: "Incluída no pacote", waived: "Isento", cancelled: "Anulado" },
  paymentMethod: { cash: "Numerário", card: "Cartão", transfer: "Transferência", mbway: "MB WAY" },
});

function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function cell(type, value) {
  return { type, value };
}

const asDate = (value) => cell("date", value);
const asDateTime = (value) => cell("datetime", value);
const asCurrency = (value) => cell("currency", Number(value) || 0);
const asInteger = (value) => cell("integer", Number(value) || 0);

function excelSerial(value, includeTime = false) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  const [, year, month, day, hour = "0", minute = "0", second = "0"] = match;
  const timestamp = Date.UTC(+year, +month - 1, +day, includeTime ? +hour : 0, includeTime ? +minute : 0, includeTime ? +second : 0);
  return timestamp / 86_400_000 + 25_569;
}

function columnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function cellXml(address, rawValue, isHeader = false) {
  let value = rawValue;
  let style = isHeader ? 1 : 0;
  let type = "text";
  if (rawValue && typeof rawValue === "object" && "type" in rawValue) {
    ({ type, value } = rawValue);
  } else if (typeof rawValue === "number") {
    type = "number";
  } else if (typeof rawValue === "boolean") {
    type = "boolean";
  }

  if (value === null || value === undefined || value === "") return `<c r="${address}"${style ? ` s="${style}"` : ""}/>`;
  if (type === "date" || type === "datetime") {
    const serial = excelSerial(value, type === "datetime");
    if (serial !== null) return `<c r="${address}" s="${type === "datetime" ? 3 : 2}"><v>${serial}</v></c>`;
    type = "text";
  }
  if (type === "currency") return `<c r="${address}" s="4"><v>${Number(value) || 0}</v></c>`;
  if (type === "integer") return `<c r="${address}" s="5"><v>${Math.trunc(Number(value) || 0)}</v></c>`;
  if (type === "number") return `<c r="${address}"><v>${Number(value) || 0}</v></c>`;
  if (type === "boolean") return `<c r="${address}" t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${address}"${style ? ` s="${style}"` : ""} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function displayLength(value) {
  if (value && typeof value === "object" && "value" in value) value = value.value;
  return String(value ?? "").length;
}

function worksheetXml(rows) {
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const rowCount = Math.max(1, rows.length);
  const widths = Array.from({ length: columnCount }, (_, column) => {
    const max = Math.max(...rows.slice(0, 250).map((row) => displayLength(row[column])));
    return Math.min(46, Math.max(10, max + 2));
  });
  const cols = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => cellXml(`${columnName(columnIndex)}${rowIndex + 1}`, value, rowIndex === 0)).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  const endCell = `${columnName(columnCount - 1)}${rowCount}`;
  const filterEnd = `${columnName(columnCount - 1)}${Math.max(1, rowCount)}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${endCell}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${cols}</cols><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:${filterEnd}"/><pageMargins left="0.4" right="0.4" top="0.6" bottom="0.6" header="0.2" footer="0.2"/></worksheet>`;
}

function normaliseData(data = {}) {
  return {
    patients: Array.isArray(data.patients) ? data.patients : [],
    appointments: Array.isArray(data.appointments) ? data.appointments : [],
    packages: Array.isArray(data.packages) ? data.packages : [],
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    evaluations: Array.isArray(data.evaluations) ? data.evaluations : [],
    transactions: Array.isArray(data.transactions) ? data.transactions : [],
  };
}

function patientLookup(patients) {
  return new Map(patients.map((patient) => [patient.id, patient.name || patient.id]));
}

function buildSheets(input, generatedAt) {
  const data = normaliseData(input);
  const names = patientLookup(data.patients);
  const patientName = (id) => id ? (names.get(id) || "Paciente não encontrado") : "";
  const packageNames = new Map(data.packages.map((item) => [item.id, item.name || `Pacote de ${item.totalSessions || 0} sessões`]));
  const usage = new Map();
  data.sessions.forEach((item) => {
    if (item.packageId) usage.set(item.packageId, (usage.get(item.packageId) || 0) + 1);
  });
  const label = (group, value) => value ? (LABELS[group]?.[value] || value) : "";
  const receipts = data.transactions.filter((item) => item.type !== "expense" && (item.sessionId || item.packageId) && item.status !== "cancelled");
  const received = receipts.filter((item) => item.status === "paid").reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const pending = receipts.filter((item) => item.status === "pending").reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const packagePaymentSummary = (packageRecord) => {
    const price = Number(packageRecord.pricePerSession) || 0;
    const active = receipts.filter((item) => item.packageId === packageRecord.id);
    const sessions = (status) => active.filter((item) => item.status === status).reduce((sum, item) => sum + (Number(item.packageSessions) || (price > 0 ? (Number(item.amount) || 0) / price : 0)), 0);
    const amount = (status) => active.filter((item) => item.status === status).reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
    return { paidSessions: sessions("paid"), pendingSessions: sessions("pending"), paidAmount: amount("paid"), pendingAmount: amount("pending") };
  };

  return [
    { name: "Resumo", rows: [
      ["Indicador", "Valor"],
      ["Exportado em", asDateTime(generatedAt.toISOString())],
      ["Pacientes", asInteger(data.patients.length)],
      ["Marcações", asInteger(data.appointments.length)],
      ["Pacotes", asInteger(data.packages.length)],
      ["Sessões", asInteger(data.sessions.length)],
      ["Avaliações", asInteger(data.evaluations.length)],
      ["Recebimentos", asInteger(receipts.length)],
      ["Recebido", asCurrency(received)],
      ["Pendente", asCurrency(pending)],
      ["Total previsto", asCurrency(received + pending)],
      ["Utilização", "Consulta e análise. Para restaurar a aplicação, use o backup JSON."],
    ] },
    { name: "Pacientes", rows: [
      ["ID", "Nome", "Data de nascimento", "NIF", "Telefone", "Email", "Morada", "Contacto de emergência", "Ativa", "Notas clínicas", "Criado em", "Atualizado em"],
      ...data.patients.map((item) => [item.id, item.name, asDate(item.birthDate), item.nif, item.phone, item.email, item.address, item.emergencyContact, item.active !== false ? "Sim" : "Não", item.clinicalNotes, asDateTime(item.createdAt), asDateTime(item.updatedAt)]),
    ] },
    { name: "Pacotes", rows: [
      ["ID", "Paciente", "Paciente ID", "Nome", "Data da compra", "Sessões contratadas", "Sessões realizadas", "Sessões por realizar", "Sessões pagas", "Sessões pendentes", "Preço por sessão (€)", "Total contratado (€)", "Recebido (€)", "Pendente (€)", "Por receber (€)", "Estado do pacote", "Notas", "Criado em", "Atualizado em"],
      ...data.packages.map((item) => {
        const used = usage.get(item.id) || 0;
        const total = Number(item.totalSessions) || 0;
        const price = Number(item.pricePerSession) || 0;
        const payments = packagePaymentSummary(item);
        const contracted = Number(item.totalAmount ?? total * price) || 0;
        return [item.id, patientName(item.patientId), item.patientId, item.name, asDate(item.purchaseDate), asInteger(total), asInteger(used), asInteger(Math.max(0, total - used)), payments.paidSessions, payments.pendingSessions, asCurrency(price), asCurrency(contracted), asCurrency(payments.paidAmount), asCurrency(payments.pendingAmount), asCurrency(Math.max(0, contracted - payments.paidAmount)), item.status === "cancelled" || item.paymentStatus === "cancelled" ? "Anulado" : used >= total && total > 0 ? "Concluído" : "Ativo", item.notes, asDateTime(item.createdAt), asDateTime(item.updatedAt)];
      }),
    ] },
    { name: "Agenda", rows: [
      ["ID", "Paciente", "Paciente ID", "Data e hora", "Duração (min)", "Tipo", "Estado", "Sala/local", "Notas", "Criado em", "Atualizado em"],
      ...data.appointments.map((item) => [item.id, patientName(item.patientId), item.patientId, asDateTime(item.start), asInteger(item.duration), label("appointmentType", item.type), label("appointmentStatus", item.status), item.room, item.notes, asDateTime(item.createdAt), asDateTime(item.updatedAt)]),
    ] },
    { name: "Sessões", rows: [
      ["ID", "Paciente", "Paciente ID", "Data", "Marcação ID", "Pacote", "Pacote ID", "Dor antes (0-10)", "Dor depois (0-10)", "Tratamento", "Exercícios / plano domiciliário", "Notas", "Valor (€)", "Estado do pagamento", "Método", "Criado em", "Atualizado em"],
      ...data.sessions.map((item) => [item.id, patientName(item.patientId), item.patientId, asDate(item.date), item.appointmentId, packageNames.get(item.packageId) || "", item.packageId, item.painBefore ?? "", item.painAfter ?? "", item.treatment, item.exercises, item.notes, asCurrency(item.value), label("paymentStatus", item.paymentStatus), label("paymentMethod", item.paymentMethod), asDateTime(item.createdAt), asDateTime(item.updatedAt)]),
    ] },
    { name: "Avaliações", rows: [
      ["ID", "Paciente", "Paciente ID", "Data", "Motivo / queixa principal", "Diagnóstico / referência médica", "História clínica", "Observação", "Postura / alinhamento", "Mobilidade / amplitudes", "Força / controlo motor", "Testes especiais / medidas", "Raciocínio clínico", "Objetivos", "Plano de intervenção", "Notas", "Criado em", "Atualizado em"],
      ...data.evaluations.map((item) => [item.id, patientName(item.patientId), item.patientId, asDate(item.date), item.reason, item.diagnosis, item.history, item.observation, item.posture, item.mobility, item.strength, item.specialTests, item.clinicalReasoning, item.goals, item.plan, item.notes, asDateTime(item.createdAt), asDateTime(item.updatedAt)]),
    ] },
    { name: "Recebimentos", rows: [
      ["ID", "Paciente", "Paciente ID", "Data", "Origem", "Sessões pagas", "Valor (€)", "Estado", "Método", "Descrição", "Sessão ID", "Pacote ID", "Notas", "Criado em", "Atualizado em"],
      ...receipts.map((item) => [item.id, patientName(item.patientId), item.patientId, asDate(item.date), item.packageId ? "Pacote" : "Sessão avulsa", item.packageSessions == null ? "" : asInteger(item.packageSessions), asCurrency(item.amount), label("paymentStatus", item.status), label("paymentMethod", item.paymentMethod), item.description, item.sessionId, item.packageId, item.notes, asDateTime(item.createdAt), asDateTime(item.updatedAt)]),
    ] },
  ];
}

function uint16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function uint32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function concat(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function zipStore(files, timestamp) {
  const localParts = [];
  const centralParts = [];
  const { time, date } = dosDateTime(timestamp);
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
    const crc = crc32(data);
    const local = concat([
      uint32(0x04034b50), uint16(20), uint16(0x0800), uint16(0), uint16(time), uint16(date),
      uint32(crc), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), name, data,
    ]);
    localParts.push(local);
    centralParts.push(concat([
      uint32(0x02014b50), uint16(20), uint16(20), uint16(0x0800), uint16(0), uint16(time), uint16(date),
      uint32(crc), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), uint16(0),
      uint16(0), uint16(0), uint32(0), uint32(offset), name,
    ]));
    offset += local.length;
  }
  const central = concat(centralParts);
  const end = concat([
    uint32(0x06054b50), uint16(0), uint16(0), uint16(files.length), uint16(files.length),
    uint32(central.length), uint32(offset), uint16(0),
  ]);
  return concat([...localParts, central, end]);
}

function workbookFiles(sheets, generatedAt) {
  const sheetOverrides = sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  const sheetEntries = sheets.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  const sheetRelations = sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
  const titles = sheets.map((sheet) => `<vt:lpstr>${xmlEscape(sheet.name)}</vt:lpstr>`).join("");
  const files = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${sheetOverrides}</Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: "docProps/core.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Exportação FISIO IF</dc:title><dc:creator>FISIO IF</dc:creator><cp:lastModifiedBy>FISIO IF</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${generatedAt.toISOString()}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${generatedAt.toISOString()}</dcterms:modified></cp:coreProperties>` },
    { name: "docProps/app.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>FISIO IF</Application><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Folhas</vt:lpstr></vt:variant><vt:variant><vt:i4>${sheets.length}</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="${sheets.length}" baseType="lpstr">${titles}</vt:vector></TitlesOfParts></Properties>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheetEntries}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRelations}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="166" formatCode="#\,##0.00 [$€-1]"/></numFmts><fonts count="2"><font><sz val="10"/><name val="Arial"/><family val="2"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Arial"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0B5F5A"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFB7D7D4"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
  ];
  sheets.forEach((sheet, index) => files.push({ name: `xl/worksheets/sheet${index + 1}.xml`, data: worksheetXml(sheet.rows) }));
  return files;
}

export function createExcelWorkbook(data, { generatedAt = new Date() } = {}) {
  const sheets = buildSheets(data, generatedAt);
  return zipStore(workbookFiles(sheets, generatedAt), generatedAt);
}

export function createExcelFileName(date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  return `fisio-if-exportacao-${stamp}.xlsx`;
}

export async function shareOrDownloadExcel({ data, filename = createExcelFileName(), preferShare = true } = {}) {
  const bytes = createExcelWorkbook(data);
  const blob = new Blob([bytes], { type: XLSX_MIME });
  if (preferShare && typeof File !== "undefined" && globalThis.navigator?.share) {
    const file = new File([blob], filename, { type: XLSX_MIME, lastModified: Date.now() });
    const shareData = { title: "Exportação Excel FISIO IF", files: [file] };
    if (!navigator.canShare || navigator.canShare(shareData)) {
      try {
        await navigator.share(shareData);
        return { ok: true, method: "share", filename, bytes: blob.size };
      } catch (error) {
        if (error?.name === "AbortError") return { ok: false, method: "cancelled", filename };
      }
    }
  }
  if (typeof document === "undefined" || !globalThis.URL?.createObjectURL) throw new Error("Este ambiente não permite guardar o ficheiro Excel automaticamente.");
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
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return { ok: true, method: "download", filename, bytes: blob.size };
}

