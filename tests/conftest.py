"""Keep tests from leaking process-wide configuration into one another.

Several legacy tests set environment variables at module import time or mutate
production/provider flags. Capture CI's baseline before test modules are imported
and restore it after each test, so admin credentials and provider enablement stay
predictable and disabled by default.
"""
import os
import pytest

_BASE_ENV = os.environ.copy()

@pytest.fixture(autouse=True)
def restore_environment_after_each_test():
    try:
        yield
    finally:
        # Pytest owns this variable and expects it to remain available while
        # fixture teardown and subsequent reporting are running.
        current_test = os.environ.get("PYTEST_CURRENT_TEST")
        # Return to the CI baseline, not the possibly polluted state left by
        # another test module during collection.
        os.environ.clear()
        os.environ.update(_BASE_ENV)
        if current_test is not None:
            os.environ["PYTEST_CURRENT_TEST"] = current_test
