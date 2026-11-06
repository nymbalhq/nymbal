// An RFC 4180 reader for the CSV files a merchant opens in a spreadsheet: records end at LF or CRLF outside quotes, a
// quoted field may hold commas, quotes (doubled) and line breaks. A trailing record separator ends the last record and
// starts none. Written here so a test reads a CSV the way a spreadsheet does, not the way its writer meant it.

export function parseCsv(text: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  let fieldStarted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"' && !fieldStarted) {
      quoted = true
      fieldStarted = true
      continue
    }
    if (c === ',') {
      record.push(field)
      field = ''
      fieldStarted = false
      continue
    }
    if (c === '\n' || (c === '\r' && text[i + 1] === '\n')) {
      if (c === '\r') i++
      record.push(field)
      records.push(record)
      record = []
      field = ''
      fieldStarted = false
      continue
    }
    if (c === '"') throw new Error(`a quote inside an unquoted field at ${i}: not RFC 4180`)
    field += c
    fieldStarted = true
  }
  if (quoted) throw new Error('an unterminated quoted field: not RFC 4180')
  if (fieldStarted || record.length > 0) {
    record.push(field)
    records.push(record)
  }
  return records
}
