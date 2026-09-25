"""精簡版排班模型：示範正式引擎的三種核心建模手法。

這不是產品的引擎原始碼。正式引擎把每條規則做成可組合的「約束積木」（24 種），
由 JSON 設定檔驅動，並處理跨月銜接、預班、變形工時、無解診斷等；此檔只保留最小可執行的骨架：

  1. 滑動視窗：任意連續 k+1 天至少休 1 天（連續上班上限）
  2. 由班別時間自動推導禁止的接班組合（兩班間隔至少 11 小時）
  3. 軟性公平：以夜班數的極差（max - min）作為懲罰項

執行：pip install ortools && python toy_scheduler.py
"""
from ortools.sat.python import cp_model

EMPLOYEES = ["A", "B", "C", "D", "E", "F", "G"]
N_DAYS = 14
# 班別：代號 -> (開始分鐘, 結束分鐘)；結束早於開始代表跨夜
SHIFTS = {"D": (8 * 60, 16 * 60), "E": (16 * 60, 24 * 60), "N": (0, 8 * 60)}
OFF = "OFF"
DEMAND = {"D": 2, "E": 1, "N": 1}          # 每日各班最低人數
MAX_CONSECUTIVE_WORK = 5
MIN_REST_HOURS = 11
FAIRNESS_WEIGHT = 10


def forbidden_transitions(min_rest_minutes: int) -> list[tuple[str, str]]:
    """前一天上 s1、隔天上 s2 時，兩班間隔不足就禁止。規則不必手寫，完全由班別時間推導。"""
    pairs = []
    for s1, (_, end1) in SHIFTS.items():
        for s2, (start2, _) in SHIFTS.items():
            rest = start2 + 1440 - end1
            if rest < min_rest_minutes:
                pairs.append((s1, s2))
    return pairs


def build_and_solve():
    m = cp_model.CpModel()
    kinds = list(SHIFTS) + [OFF]
    x = {(e, d, s): m.NewBoolVar(f"x_{e}_{d}_{s}")
         for e in EMPLOYEES for d in range(N_DAYS) for s in kinds}

    # 每人每天恰好一種狀態（含休假）
    for e in EMPLOYEES:
        for d in range(N_DAYS):
            m.AddExactlyOne(x[e, d, s] for s in kinds)

    # 人力需求
    for d in range(N_DAYS):
        for s, need in DEMAND.items():
            m.Add(sum(x[e, d, s] for e in EMPLOYEES) >= need)

    # 1. 滑動視窗：任意連續 MAX+1 天內至少 1 天休息
    window = MAX_CONSECUTIVE_WORK + 1
    for e in EMPLOYEES:
        for start in range(N_DAYS - window + 1):
            m.Add(sum(x[e, start + k, OFF] for k in range(window)) >= 1)

    # 2. 班距：禁止的接班組合，以子句 (not a) or (not b) 表示
    for s1, s2 in forbidden_transitions(MIN_REST_HOURS * 60):
        for e in EMPLOYEES:
            for d in range(1, N_DAYS):
                m.AddBoolOr([x[e, d - 1, s1].Not(), x[e, d, s2].Not()])

    # 3. 軟性公平：夜班數極差越小越好
    nights = []
    for e in EMPLOYEES:
        v = m.NewIntVar(0, N_DAYS, f"nights_{e}")
        m.Add(v == sum(x[e, d, "N"] for d in range(N_DAYS)))
        nights.append(v)
    hi, lo = m.NewIntVar(0, N_DAYS, "hi"), m.NewIntVar(0, N_DAYS, "lo")
    m.AddMaxEquality(hi, nights)
    m.AddMinEquality(lo, nights)

    # 次要目標：總出勤天數越少越好（只排剛好夠的人力）
    total_work = sum(x[e, d, s] for e in EMPLOYEES for d in range(N_DAYS) for s in SHIFTS)
    m.Minimize(FAIRNESS_WEIGHT * (hi - lo) + total_work)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 10
    solver.parameters.num_search_workers = 8
    status = solver.Solve(m)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        print("無解")
        return

    print(f"狀態：{solver.StatusName(status)}，夜班數極差 {solver.Value(hi) - solver.Value(lo)}")
    print("     " + " ".join(f"{d + 1:>3}" for d in range(N_DAYS)))
    for e in EMPLOYEES:
        row = []
        for d in range(N_DAYS):
            s = next(s for s in kinds if solver.Value(x[e, d, s]))
            row.append("  ." if s == OFF else f"{s:>3}")
        print(f"{e:>4} " + " ".join(row))


if __name__ == "__main__":
    build_and_solve()
