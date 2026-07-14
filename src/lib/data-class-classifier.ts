import type { DataClass } from "@/lib/modelRouter";

export const COUNCIL_PRIVATE_REFUSAL = "The Council can't review private data (I-9, finance, email content). Ask a specific domestic office (Groq/Ollama) or handle it in the normal private-data flow.";

const SECRET_VALUE_PATTERN = /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password)\s*[:=]\s*\S+/i;

const PRIVATE_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN
  /\b\d{2}-\d{7}\b/, // EIN
  /\b(?:i-?9|e-?verify|employment authorization|work authorization|alien registration|a-number)\b/i,
  /\b(?:bank account|routing number|checking account|savings account|credit card|debit card|account number|tax return|pay stub|payroll)\b/i,
  /(?:^|\n)\s*from:\s*.+(?:\n|\r\n?)\s*(?:to|sent|date):\s*.+(?:\n|\r\n?)\s*subject:/i,
  /\b(?:email body|pasted email|inbox message|gmail message)\b/i,
];

export function classifyCouncilMessage(message: string): DataClass {
  const text = message.trim();
  if (SECRET_VALUE_PATTERN.test(text)) return "SECRET";
  if (PRIVATE_PATTERNS.some((pattern) => pattern.test(text))) return "PRIVATE";
  return "PUBLIC";
}
