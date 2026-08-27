class AuthService:
    """Handles auth."""

    def __init__(self):
        self._token = "secret-token-456"

    def login(self, name):
        return f"hello {name}"