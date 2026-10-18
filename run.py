import os
from pathlib import Path
import uvicorn

if __name__ == "__main__":
    db_path = Path(os.environ.get("DATABASE_PATH", "naqaa_market.db")).expanduser()
    db_dir = db_path.parent if str(db_path.parent) else Path(".")
    db_dir.mkdir(parents=True, exist_ok=True)
    if str(db_dir).startswith("/data"):
        try:
            db_dir.chmod(0o777)
        except OSError:
            pass
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("app:app", host="0.0.0.0", port=port)
