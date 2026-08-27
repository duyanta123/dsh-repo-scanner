from .auth import AuthService


def build_app():
    svc = AuthService()
    return svc