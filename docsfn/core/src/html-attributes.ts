/** Scan opening tags without crossing quotes or retrying unmatched '<' prefixes. */
export function mapHtmlAttributes(
  source: string,
  transform: (name: string, value: string, raw: string) => string,
): string {
  let output = "", cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("<", cursor);
    if (start < 0) return output + source.slice(cursor);
    output += source.slice(cursor, start);
    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4);
      cursor = end < 0 ? source.length : end + 3;
      output += source.slice(start, cursor);
      continue;
    }
    let index = start + 1;
    if (!/[a-z]/i.test(source[index] ?? "")) { output += "<"; cursor = index; continue; }
    while (index < source.length && /[a-z0-9:-]/i.test(source[index])) index++;
    let tag = source.slice(start, index);
    while (index < source.length && source[index] !== ">" && source[index] !== "<") {
      const prefixStart = index;
      while (index < source.length && /[\s/]/.test(source[index])) index++;
      const prefix = source.slice(prefixStart, index);
      if (source[index] === ">" || source[index] === "<" || index === source.length) { tag += prefix; break; }
      const nameStart = index;
      while (index < source.length && !/[\s=<>/]/.test(source[index])) index++;
      if (index === nameStart) { tag += prefix + source[index++]; continue; }
      const name = source.slice(nameStart, index);
      const nameEnd = index;
      while (/\s/.test(source[index] ?? "") && index < source.length) index++;
      let value = "";
      if (source[index] === "=") {
        index++;
        while (/\s/.test(source[index] ?? "") && index < source.length) index++;
        const quote = source[index] === '"' || source[index] === "'" ? source[index++] : undefined;
        const valueStart = index;
        if (quote) { while (index < source.length && source[index] !== quote) index++; }
        else { while (index < source.length && !/[\s>]/.test(source[index])) index++; }
        value = source.slice(valueStart, index);
        if (quote && source[index] === quote) index++;
      } else index = nameEnd;
      tag += transform(name.toLowerCase(), value, prefix + source.slice(nameStart, index));
    }
    if (source[index] === ">") tag += source[index++];
    output += tag;
    cursor = index;
  }
  return output;
}
