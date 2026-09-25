# backend

正式服務的後端節錄，**無法單獨執行**：排班引擎（`engine/` 下除 `schema.py` 以外的模組）
未公開，`api/main.py` 開頭對 `engine.solver`、`engine.checker`、`engine.lint` 的 import 會失敗。

| 路徑 | 內容 |
|---|---|
| `api/main.py` | FastAPI 路由：認證、班表文件、背景求解工作、檢核、匯入匯出、管理後台 |
| `api/auth.py` | scrypt 密碼雜湊、登入限流 |
| `api/db.py` | SQLite 資料層（WAL 模式）、種子資料庫初始化 |
| `api/xlsx_export.py` / `xlsx_import.py` | 格式化 Excel 匯出、人員名單與班表匯入 |
| `engine/schema.py` | Schema v1 的 Pydantic 模型：引擎的輸入與輸出格式 |
| `tests/test_api_security.py` | API 安全性測試（以假的求解器取代引擎） |

原始目錄為 `app/api`、`app/engine`，此處為了展示而扁平化，相對 import 保持原樣。
