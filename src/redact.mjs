// Public logs are best-effort redacted, not a confidentiality boundary.
export function redact(value,secrets=[]) {
  if(Array.isArray(value))return value.map(v=>redact(v,secrets));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>k!=='_context').map(([k,v])=>[k,/(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential|private[_-]?key)/i.test(k)?'[redacted]':redact(v,secrets)]));
  if(typeof value!=='string')return value;
  let text=value;
  for(const secret of secrets.filter(s=>typeof s==='string'&&s.length>=8).sort((a,b)=>b.length-a.length))text=text.replaceAll(secret,'[redacted]');
  return text.replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g,'[private key redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi,'[authorization redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|dop_v1_[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,'[token redacted]')
    .replace(/(https?:\/\/)[^\s\/:@]+:[^\s\/@]+@/g,'$1[credentials redacted]@');
}
