export const REDACTED = "<redacted>";

// mongodb://user:pass@host and mongodb+srv://user:pass@host: the password never reaches stdout.
const URI_PASSWORD = /(mongodb(?:\+srv)?:\/\/[^:@/\s]*:)[^@\s]*@/gi;

export function redactSecrets(text: string): string {
  return text.replace(URI_PASSWORD, `$1${REDACTED}@`);
}

/** Field names whose values are credentials (app passwords, SCRAM credentials in system.users). */
export const isSecretKey = (name: string): boolean => /^(password|pwd|credentials)$/i.test(name);
