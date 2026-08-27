export class AuthService {
  private token = 'secret-token-123';
  login(name: string): string {
    return `hello ${name}`;
  }
}