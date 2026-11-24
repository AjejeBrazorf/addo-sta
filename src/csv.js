/** Yield CSV rows as objects, including quoted commas and quotes. */
export function* iterateCsv(buffer) {
  let text = buffer.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let field = "";
  let row = [];
  let header = null;
  const emit = () => {
    if (!row.some((cell) => cell !== "") && field === "") {
      row = [];
      return;
    }
    row.push(field);
    field = "";
    if (!header) {
      header = row.map((name) => name.trim());
    } else {
      const obj = {};
      header.forEach((name, index) => {
        obj[name] = row[index] ?? "";
      });
      row = [];
      return obj;
    }
    row = [];
    return null;
  };
  // Fields are sliced between indices; `field` only collects pieces around quotes.
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 34) {
      // '"': copy up to the closing quote, "" becomes ".
      field += text.slice(start, i);
      let from = i + 1;
      for (;;) {
        const close = text.indexOf('"', from);
        if (close < 0) {
          field += text.slice(from);
          i = text.length;
          break;
        }
        if (text.charCodeAt(close + 1) === 34) {
          field += text.slice(from, close + 1);
          from = close + 2;
          continue;
        }
        field += text.slice(from, close);
        i = close;
        break;
      }
      start = i + 1;
      continue;
    }
    if (c === 44) {
      row.push(field + text.slice(start, i));
      field = "";
      start = i + 1;
      continue;
    }
    if (c === 10 || c === 13) {
      field += text.slice(start, i);
      if (c === 13 && text.charCodeAt(i + 1) === 10) i += 1;
      start = i + 1;
      const value = emit();
      if (value) yield value;
    }
  }
  field += text.slice(start);
  const last = emit();
  if (last) yield last;
}

export function parseCsv(buffer) {
  return [...iterateCsv(buffer)];
}
