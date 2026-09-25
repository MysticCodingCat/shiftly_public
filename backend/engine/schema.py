"""排班問題 Schema v1 的 pydantic 資料模型。

對應 spec/schema-v1.md。JSON 採 camelCase，Python 屬性採 snake_case。
"""
from __future__ import annotations

from datetime import date as Date
from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="allow",  # 未知欄位忽略並保留（相容策略）
    )


class Meta(CamelModel):
    name: str = ""
    organization: str = ""
    timezone: str = "Asia/Taipei"
    template_id: Optional[str] = None


class Block(CamelModel):
    id: str
    start: Date
    end: Date
    type: str = "four_weeks"


class Horizon(CamelModel):
    start: Date
    end: Date
    week_starts_on: Literal["sunday", "monday"] = "sunday"
    blocks: list[Block] = Field(default_factory=list)


class Holiday(CamelModel):
    date: Date
    name: str = ""


class Calendar(CamelModel):
    holidays: list[Holiday] = Field(default_factory=list)


class Shift(CamelModel):
    id: str
    name: str = ""
    kind: Literal["work", "rest", "leave"] = "work"
    start: Optional[str] = None  # "HH:MM"
    end: Optional[str] = None
    hours: float = 0
    overtime_hours: float = 0
    tags: list[str] = Field(default_factory=list)


class Quota(CamelModel):
    annual: int = 0
    used: int = 0


class Employee(CamelModel):
    id: str
    name: str = ""
    level: Literal["regular", "support", "virtual"] = "regular"
    attributes: dict[str, Any] = Field(default_factory=dict)
    allowed_shifts: Optional[list[str]] = None  # None = 全部工作班別皆可
    skills: list[str] = Field(default_factory=list)
    quotas: dict[str, Quota] = Field(default_factory=dict)
    exemptions: list[str] = Field(default_factory=list)
    end_date: Optional[Date] = None


class HistoryEntry(CamelModel):
    employee_id: str
    date: Date
    shift_id: str


class PreAssignment(CamelModel):
    employee_id: str
    date: Optional[Date] = None
    date_range: Optional[list[Date]] = None  # [start, end]
    assign: Optional[list[str]] = None
    forbid: Optional[list[str]] = None
    mode: Literal["lock", "prefer"] = "lock"
    weight: int = 30

    def dates_in(self, all_dates: list[Date]) -> list[Date]:
        if self.date is not None:
            return [self.date] if self.date in all_dates else []
        if self.date_range:
            lo, hi = self.date_range[0], self.date_range[-1]
            return [d for d in all_dates if lo <= d <= hi]
        return []


class Condition(CamelModel):
    """人員屬性條件；支援 and 組合。"""
    field: Optional[str] = None
    op: Optional[str] = None
    value: Any = None
    and_: Optional[list["Condition"]] = Field(default=None, alias="and")


class DemandAdjustment(CamelModel):
    days_of_week: list[str] = Field(default_factory=list)  # "mon".."sun"
    dates: list[Date] = Field(default_factory=list)
    delta: int = 0


class DemandExcept(CamelModel):
    holidays: bool = False
    dates: list[Date] = Field(default_factory=list)


class Demand(CamelModel):
    shift_id: str
    min: Optional[int] = None
    max: Optional[int] = None
    adjustments: list[DemandAdjustment] = Field(default_factory=list)
    except_: Optional[DemandExcept] = Field(default=None, alias="except")
    qualifier: Optional[Condition] = None
    min_qualified: Optional[int] = None
    enforcement: Literal["hard", "soft"] = "hard"
    weight: int = 100


class ShiftSelector(CamelModel):
    ids: Optional[list[str]] = None
    tags: Optional[list[str]] = None
    kinds: Optional[list[str]] = None


class ConstraintScope(CamelModel):
    employees: Optional[Condition] = None
    exclude_exemptions: list[str] = Field(default_factory=list)


class Constraint(CamelModel):
    id: str
    block: str
    enabled: bool = True
    enforcement: Literal["hard", "soft"] = "hard"
    weight: Optional[int] = None
    scope: Optional[ConstraintScope] = None
    params: dict[str, Any] = Field(default_factory=dict)


class SolverConfig(CamelModel):
    time_limit_seconds: float = 60
    diagnose_on_infeasible: bool = True
    diagnose_probe_seconds: float = 10
    diagnose_budget_seconds: float = 180   # 無解診斷的總時間上限（逐一試解可能很多輪）
    seed: Optional[int] = None
    num_workers: int = 8


class Problem(CamelModel):
    schema_version: str = "1.0"
    meta: Meta = Field(default_factory=Meta)
    horizon: Horizon
    calendar: Calendar = Field(default_factory=Calendar)
    shifts: list[Shift]
    employees: list[Employee]
    history: list[HistoryEntry] = Field(default_factory=list)
    pre_assignments: list[PreAssignment] = Field(default_factory=list)
    demands: list[Demand] = Field(default_factory=list)
    constraints: list[Constraint] = Field(default_factory=list)
    solver: SolverConfig = Field(default_factory=SolverConfig)


# ---- 輸出 ----

class Assignment(CamelModel):
    employee_id: str
    date: Date
    shift_id: str


class SoftViolation(CamelModel):
    constraint_id: str
    employee_id: Optional[str] = None
    date: Optional[Date] = None
    cost: int = 0
    message: str = ""


class EmployeeStats(CamelModel):
    employee_id: str
    hours: float = 0
    overtime_hours: float = 0
    rest_days: int = 0
    weekend_rest_days: int = 0
    shift_counts: dict[str, int] = Field(default_factory=dict)


class Diagnosis(CamelModel):
    conflict_ids: list[str] = Field(default_factory=list)
    suggestions: list[str] = Field(default_factory=list)


class SolveResult(CamelModel):
    status: Literal["optimal", "feasible", "infeasible", "timeout", "error"]
    objective_value: Optional[float] = None
    assignments: list[Assignment] = Field(default_factory=list)
    soft_violations: list[SoftViolation] = Field(default_factory=list)
    stats: list[EmployeeStats] = Field(default_factory=list)
    diagnosis: Optional[Diagnosis] = None
    warnings: list[str] = Field(default_factory=list)
    solve_seconds: float = 0
    error: Optional[str] = None
