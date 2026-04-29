import dayjs from "dayjs";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

export interface JournalCsvRow {
  date: string;
  prompt: string;
}

const JOURNAL_CSV_HEADER = ["date", "prompt"] as const;

export function validateJournalDate(date: string): string | null {
  return dayjs.utc(date, "YYYY-MM-DD", true).isValid() ? date : null;
}

export function serializeJournalCsv(rows: JournalCsvRow[]): string {
  return stringify(rows, {
    header: true,
    columns: JOURNAL_CSV_HEADER,
    record_delimiter: "\n",
  });
}

export function parseJournalCsv(content: string): JournalCsvRow[] {
  const rows: string[][] = parse(content, {
    bom: true,
    relax_column_count: false,
    skip_empty_lines: true,
  });

  if (rows.length === 0) throw new Error("CSV is empty.");

  const header = rows[0];
  if (!header) throw new Error("CSV is empty.");

  const dataRows = rows.slice(1);
  const normalizedHeader = header.map((column, index) => (index === 0 ? column.replace(/^\uFEFF/, "") : column));
  if (normalizedHeader.length !== JOURNAL_CSV_HEADER.length) {
    throw new Error(`CSV header must be exactly: ${JOURNAL_CSV_HEADER.join(",")}`);
  }

  for (const [index, expected] of JOURNAL_CSV_HEADER.entries()) {
    if (normalizedHeader[index] !== expected) {
      throw new Error(`CSV header must be exactly: ${JOURNAL_CSV_HEADER.join(",")}`);
    }
  }

  const parsedRows: JournalCsvRow[] = [];

  dataRows.forEach((row, index) => {
    const rowNumber = index + 2;

    if (row.length === 1 && row[0] === "") return;
    if (row.length !== JOURNAL_CSV_HEADER.length) throw new Error(`Row ${rowNumber} must contain exactly 2 columns.`);

    const [date, prompt] = row as [string, string];
    const normalizedDate = validateJournalDate(date);

    if (!normalizedDate)            throw new Error(`Row ${rowNumber} has an invalid date: ${date}`);
    if (prompt.trim().length === 0) throw new Error(`Row ${rowNumber} has an empty prompt.`);

    parsedRows.push({ date: normalizedDate, prompt });
  });

  return parsedRows;
}
