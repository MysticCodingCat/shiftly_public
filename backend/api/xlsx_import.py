"""Excel 匯入：人員名單、預班請假表、上期班表。

設計原則：容忍真實世界的 Excel——欄位順序可變、有無標題列皆可、
日期可為數字或文字、空白列自動跳過。解析失敗回報明確訊息而非丟例外。
"""
from __future__ import annotations

import io
import re
from datetime import date, datetime
from typing import Any, Optional

from openpyxl import load_workbook

# 人員欄位的可接受標題（容忍不同寫法）
STAFF_HEADERS = {
    "id": ["編號", "員工編號", "工號", "代號", "id", "employee id"],
    "name": ["姓名", "名字", "員工姓名", "name"],
    "title": ["職稱", "職務", "title"],
    "seniority": ["年資", "到職年資", "年資(年)", "seniority"],
    "group": ["小組", "組別", "團隊", "group"],
    "defaultShift": ["預設班別", "常態班別", "包班", "default shift"],
    "skills": ["技能", "證照", "專長", "skills"],
}


def _norm(v: Any) -> str:
    return str(v).strip().lower().replace(" ", "") if v is not None else ""


def _cell_date(v: Any, year: int, month: int) -> Optional[date]:
    """把儲存格解析成日期：支援 datetime、'2026/09/05'、'9/5'、單純數字 5。"""
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    if isinstance(v, (int, float)) and 1 <= int(v) <= 31:
        try:
            return date(year, month, int(v))
        except ValueError:
            return None
    s = str(v).strip()
    if not s:
        return None
    m = re.match(r"^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$", s)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    m = re.match(r"^(\d{1,2})[/\-.](\d{1,2})$", s)
    if m:
        try:
            return date(year, int(m.group(1)), int(m.group(2)))
        except ValueError:
            return None
    if s.isdigit() and 1 <= int(s) <= 31:
        try:
            return date(year, month, int(s))
        except ValueError:
            return None
    return None


def _find_header_row(rows: list[list[Any]], wanted: list[str], max_scan: int = 10) -> tuple[int, dict]:
    """在前幾列中找出標題列，回傳 (列索引, {欄位: 欄索引})。找不到回 (-1, {})。"""
    for i, row in enumerate(rows[:max_scan]):
        norm = [_norm(c) for c in row]
        mapping = {}
        for key, aliases in STAFF_HEADERS.items():
            for j, cell in enumerate(norm):
                if cell and any(cell == _norm(a) for a in aliases):
                    mapping[key] = j
                    break
        if all(k in mapping for k in wanted):
            return i, mapping
    return -1, {}


def parse_staff(content: bytes) -> dict:
    """人員名單。必要欄位：編號；其餘可選。"""
    wb = load_workbook(io.BytesIO(content), data_only=True)
    ws = wb.active
    rows = [list(r) for r in ws.iter_rows(values_only=True)]
    hdr_i, cols = _find_header_row(rows, ["id"])
    if hdr_i < 0:
        return {"error": "找不到「編號」欄位。請確認第一列包含欄位標題（編號、姓名、職稱、年資、小組、預設班別、技能）"}

    employees = []
    for row in rows[hdr_i + 1:]:
        if not row or all(c is None or str(c).strip() == "" for c in row):
            continue
        get = lambda k: (row[cols[k]] if k in cols and cols[k] < len(row) else None)
        emp_id = get("id")
        if emp_id is None or str(emp_id).strip() == "":
            continue
        seniority = get("seniority")
        try:
            seniority = float(seniority) if seniority not in (None, "") else 0.0
        except (TypeError, ValueError):
            seniority = 0.0
        skills_raw = get("skills")
        skills = [s.strip() for s in re.split(r"[,;、/]", str(skills_raw))
                  if s.strip()] if skills_raw else []
        employees.append({
            "id": str(emp_id).strip(),
            "name": str(get("name") or "").strip(),
            "level": "regular",
            "attributes": {
                "title": str(get("title") or "").strip(),
                "seniorityYears": seniority,
                "isNew": seniority < 0.5,
                "group": (str(get("group")).strip() or None) if get("group") else None,
                "defaultShift": (str(get("defaultShift")).strip() or None) if get("defaultShift") else None,
                "mentorId": None,
            },
            "skills": skills,
            "exemptions": [],
        })
    if not employees:
        return {"error": "找到標題列但沒有讀到任何人員資料"}
    return {"employees": employees}


def parse_grid(content: bytes, year: int, month: int, kind: str) -> dict:
    """網格式表格：第一欄為人員編號，其餘欄為日期，格內為班別代碼。

    kind = "preassign"（預班請假）或 "history"（上期班表）
    """
    wb = load_workbook(io.BytesIO(content), data_only=True)
    ws = wb.active
    rows = [list(r) for r in ws.iter_rows(values_only=True)]
    if len(rows) < 2:
        return {"error": "檔案內容不足兩列"}

    # 找日期標題列：至少兩個可解析為日期的儲存格，且日期由左至右遞增
    # （遞增條件可有效排除「編號 1 2」這類非日期的數字標題）
    hdr_i, date_cols = -1, {}
    for i, row in enumerate(rows[:10]):
        cand = {}
        for j, cell in enumerate(row):
            if j == 0:
                continue
            d = _cell_date(cell, year, month)
            if d is not None:
                cand[j] = d
        if len(cand) >= 2:
            seq = [cand[j] for j in sorted(cand)]
            if all(a < b for a, b in zip(seq, seq[1:])):
                hdr_i, date_cols = i, cand
                break
    if hdr_i < 0:
        return {"error": "找不到日期標題列。請將第一欄放人員編號，第一列放日期（可用 1、2、3… 或 2026/09/01）"}

    # 找人員編號欄（預設第一欄，若第一欄多為空則試第二欄）
    id_col = 0
    for c in (0, 1):
        hits = sum(1 for row in rows[hdr_i + 1:]
                   if len(row) > c and row[c] is not None and str(row[c]).strip())
        if hits >= 1:
            id_col = c
            break

    entries = []
    seen_shifts = set()
    for row in rows[hdr_i + 1:]:
        if not row or len(row) <= id_col:
            continue
        emp_id = row[id_col]
        if emp_id is None or str(emp_id).strip() == "":
            continue
        emp_id = str(emp_id).strip()
        for col, d in date_cols.items():
            if col >= len(row):
                continue
            val = row[col]
            if val is None or str(val).strip() == "":
                continue
            shift = str(val).strip()
            seen_shifts.add(shift)
            if kind == "history":
                entries.append({"employeeId": emp_id, "date": d.isoformat(), "shiftId": shift})
            else:
                entries.append({"employeeId": emp_id, "date": d.isoformat(),
                                "assign": [shift], "mode": "lock"})
    if not entries:
        return {"error": "找到日期列但沒有讀到任何班別資料"}
    return {"entries": entries, "shiftsSeen": sorted(seen_shifts),
            "employeesSeen": sorted({e["employeeId"] for e in entries})}
