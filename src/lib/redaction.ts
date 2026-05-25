const SECRET_ASSIGNMENT =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*([^\s]+)/gi;

export function redactSecrets(input: string): string {
  return input.replace(SECRET_ASSIGNMENT, "$1=[REDACTED]");
}
