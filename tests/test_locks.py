"""条款锁定（定稿保护）后端测试。

锁定集合随写稿请求（保存 / 删除 / 合并 / 拆分 / 复制）以 ``locked_ids`` 提交，
由后端核验操作的实际结果：
- 形态问题（身份非法 / 重复 / 不存在 / 被锁条款含失效引用）→ 422；
- 改变锁定条款身份、内部正文或使其有效引用失效 → 409，按操作前当前顺序
  列出受影响的锁定身份与原因，草稿不变；
- 不冻结被引用条款正文，纯重排与编号变化允许，复制允许且副本不锁定；
- 旧调用不传集合时完全沿用原规则。
"""

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _import(text):
    r = client.post("/api/import", json={"text": text})
    assert r.status_code == 200, r.text
    return r.json()["clauses"]


@pytest.fixture
def doc():
    clauses = _import(
        "\n".join(
            [
                "1|甲方在七日内交付设备",
                "2|乙方按 [[1]] 验收后付款",
                "3|争议解决见 [[2]]",
                "4|争议提交仲裁",
            ]
        )
    )
    return {
        "order_ids": ["c1", "c2", "c3", "c4"],
        "clauses": [{"id": c["id"], "body": c["body"]} for c in clauses],
    }


def _post(path, doc, **extra):
    payload = {
        "order_ids": list(doc["order_ids"]),
        "clauses": [dict(c) for c in doc["clauses"]],
        **extra,
    }
    return client.post(path, json=payload)


def _with(doc, **changes):
    """派生一份草稿副本并覆盖 order_ids / clauses。"""
    out = {"order_ids": list(doc["order_ids"]), "clauses": [dict(c) for c in doc["clauses"]]}
    out.update(changes)
    return out


# --------------------------------------------------------------------------- #
# 锁定集合形态校验（422）
# --------------------------------------------------------------------------- #
def test_locked_ids_reject_unknown_duplicate_and_bad_shape(doc):
    r = _post("/api/delete", doc, delete_id="c4", locked_ids=["c9"])
    assert r.status_code == 422
    assert any("不存在" in e for e in r.json()["detail"]["errors"])

    r = _post("/api/delete", doc, delete_id="c4", locked_ids=["c2", "c2"])
    assert r.status_code == 422
    assert any("重复" in e for e in r.json()["detail"]["errors"])

    r = _post("/api/delete", doc, delete_id="c4", locked_ids=["x2"])
    assert r.status_code == 422


def test_locked_clause_with_broken_ref_cannot_be_locked(doc):
    # c1 已删除、c2 含失效引用 [[c1]] 的草稿
    broken = _with(doc, order_ids=["c2", "c3", "c4"], clauses=[dict(c) for c in doc["clauses"] if c["id"] != "c1"])
    r = _post("/api/delete", broken, delete_id="c4", locked_ids=["c2"])
    assert r.status_code == 422
    assert any("失效引用" in e for e in r.json()["detail"]["errors"])


def test_empty_lock_set_is_allowed_and_enforces_nothing(doc):
    r = _post("/api/delete", doc, delete_id="c1", locked_ids=[])
    assert r.status_code == 200


# --------------------------------------------------------------------------- #
# 旧调用兼容：不传 locked_ids 完全沿用原规则
# --------------------------------------------------------------------------- #
def test_legacy_calls_without_locked_ids_keep_old_rules(doc):
    r = _post("/api/delete", doc, delete_id="c1")
    assert r.status_code == 200
    assert "c1" not in r.json()["order_ids"]

    r = _post("/api/save", doc, edit_id="c2", text="全新正文")
    assert r.status_code == 200
    r = _post("/api/merge", doc, keep_id="c1", drop_id="c2")
    assert r.status_code == 200
    r = _post("/api/split", doc, split_id="c1", offset=2, new_id="c5", refs_to="front")
    assert r.status_code == 200
    r = _post("/api/duplicate", doc, selected_ids=["c2"], next_id=4)
    assert r.status_code == 200


# --------------------------------------------------------------------------- #
# 删除
# --------------------------------------------------------------------------- #
def test_delete_locked_clause_rejected(doc):
    r = _post("/api/delete", doc, delete_id="c2", locked_ids=["c2"])
    assert r.status_code == 409
    assert r.json()["detail"]["locked_errors"] == [
        {"id": "c2", "original": 2, "reason": "removed"}
    ]


def test_delete_target_of_locked_ref_rejected(doc):
    # c2 锁定且引用 c1：删除 c1 会使锁定条款引用失效
    r = _post("/api/delete", doc, delete_id="c1", locked_ids=["c2"])
    assert r.status_code == 409
    assert r.json()["detail"]["locked_errors"] == [
        {"id": "c2", "original": 2, "reason": "ref_broken", "ref_id": "c1", "ref_original": 1}
    ]


def test_delete_unreferenced_unlocked_clause_allowed_with_locks(doc):
    # c2 锁定；删除与它无关的 c4（无人引用 c4）→ 允许
    r = _post("/api/delete", doc, delete_id="c4", locked_ids=["c2"])
    assert r.status_code == 200
    assert r.json()["order_ids"] == ["c1", "c2", "c3"]


def test_delete_lists_affected_in_pre_operation_order(doc):
    # 锁定 c1 与 c2，删除 c1：c1 removed、c2 ref_broken，按操作前顺序（与传入顺序无关）
    r = _post("/api/delete", doc, delete_id="c1", locked_ids=["c2", "c1"])
    assert r.status_code == 409
    errors = r.json()["detail"]["locked_errors"]
    assert [(e["id"], e["reason"]) for e in errors] == [
        ("c1", "removed"),
        ("c2", "ref_broken"),
    ]


def test_delete_rejected_has_no_server_side_effect(doc):
    # 接口无状态：拒绝后再以无集合请求同一删除应成功
    r = _post("/api/delete", doc, delete_id="c1", locked_ids=["c2"])
    assert r.status_code == 409
    r2 = _post("/api/delete", doc, delete_id="c1")
    assert r2.status_code == 200


# --------------------------------------------------------------------------- #
# 保存
# --------------------------------------------------------------------------- #
def test_save_locked_clause_rejected(doc):
    r = _post("/api/save", doc, edit_id="c2", text="全新的正文", locked_ids=["c2"])
    assert r.status_code == 409
    assert r.json()["detail"]["locked_errors"][0]["reason"] == "body_changed"


def test_save_unlocked_referenced_clause_allowed(doc):
    # c2 锁定并引用 c1；编辑 c1（被引用条款）不冻结其正文 → 允许
    r = _post("/api/save", doc, edit_id="c1", text="甲方改为三十日交付", locked_ids=["c2"])
    assert r.status_code == 200
    assert r.json()["body"] == "甲方改为三十日交付"


def test_save_result_with_identical_body_is_not_a_violation(doc):
    # 结果中锁定条款正文与原内部正文逐字相同：不构成冲突
    changed = _with(
        doc,
        clauses=[
            dict(c, body="无引用的新正文") if c["id"] == "c2" else c for c in doc["clauses"]
        ],
    )
    r = _post("/api/save", changed, edit_id="c2", text="无引用的新正文", locked_ids=["c2"])
    assert r.status_code == 200
    assert r.json()["body"] == "无引用的新正文"


# --------------------------------------------------------------------------- #
# 合并
# --------------------------------------------------------------------------- #
def test_merge_into_locked_clause_rejected(doc):
    # keep=c2（锁）在前位、drop=c3：合并结果沿用 c2 但正文拼接 → body_changed
    r = _post("/api/merge", doc, keep_id="c2", drop_id="c3", locked_ids=["c2"])
    assert r.status_code == 409
    assert r.json()["detail"]["locked_errors"][0]["reason"] == "body_changed"


def test_merge_removing_locked_clause_rejected(doc):
    # keep=c1、drop=c2（锁）：锁定身份被移除
    r = _post("/api/merge", doc, keep_id="c1", drop_id="c2", locked_ids=["c2"])
    assert r.status_code == 409
    assert r.json()["detail"]["locked_errors"][0]["reason"] == "removed"


def test_merge_repointing_ref_in_locked_clause_rejected(doc):
    # c3 锁定，其正文引用 c2；keep=c1、drop=c2 会把 c3 内 [[c2]] 改指 c1
    changed = _with(
        doc,
        clauses=[
            dict(c, body="争议解决见 [[c2]]") if c["id"] == "c3" else c for c in doc["clauses"]
        ],
    )
    r = _post("/api/merge", changed, keep_id="c1", drop_id="c2", locked_ids=["c3"])
    assert r.status_code == 409
    assert r.json()["detail"]["locked_errors"][0]["reason"] == "body_changed"


def test_merge_unrelated_to_locks_allowed(doc):
    # c4 锁定，合并 c1/c2 与其无关 → 允许
    r = _post("/api/merge", doc, keep_id="c1", drop_id="c2", locked_ids=["c4"])
    assert r.status_code == 200


# --------------------------------------------------------------------------- #
# 拆分
# --------------------------------------------------------------------------- #
def test_split_locked_clause_rejected(doc):
    r = _post(
        "/api/split",
        doc,
        split_id="c2",
        offset=3,
        new_id="c5",
        refs_to="front",
        locked_ids=["c2"],
    )
    assert r.status_code == 409
    assert r.json()["detail"]["locked_errors"][0]["reason"] == "body_changed"


def test_split_referenced_target_to_front_keeps_locked(doc):
    # c2 锁定并引用 c1；拆分 c1，引用落前段：c2 正文与引用均不变 → 允许
    r = _post(
        "/api/split",
        doc,
        split_id="c1",
        offset=2,
        new_id="c5",
        refs_to="front",
        locked_ids=["c2"],
    )
    assert r.status_code == 200
    c2 = next(c for c in r.json()["clauses"] if c["id"] == "c2")
    assert c2["body"] == "乙方按 [[c1]] 验收后付款"


def test_split_referenced_target_to_back_changes_locked_body(doc):
    # c2 锁定并引用 c1；拆分 c1，引用落后段 c5：c2 内引用改写 → body_changed
    r = _post(
        "/api/split",
        doc,
        split_id="c1",
        offset=2,
        new_id="c5",
        refs_to="back",
        locked_ids=["c2"],
    )
    assert r.status_code == 409
    assert r.json()["detail"]["locked_errors"][0]["reason"] == "body_changed"


def test_split_unrelated_clause_allowed_with_locks(doc):
    r = _post(
        "/api/split",
        doc,
        split_id="c4",
        offset=2,
        new_id="c5",
        refs_to="front",
        locked_ids=["c2"],
    )
    assert r.status_code == 200


# --------------------------------------------------------------------------- #
# 复制
# --------------------------------------------------------------------------- #
def test_duplicate_allowed_with_locks_and_copies_unlocked(doc):
    r = _post(
        "/api/duplicate",
        doc,
        selected_ids=["c1", "c2"],
        next_id=4,
        locked_ids=["c1", "c2"],
    )
    assert r.status_code == 200
    data = r.json()
    # 整组副本插在所选最后一条 c2 之后；原条款身份、正文不变；
    # 副本取全新身份（锁定集合只存调用方，副本不锁定）
    assert data["order_ids"] == ["c1", "c2", "c5", "c6", "c3", "c4"]
    assert data["next_id"] == 6


# --------------------------------------------------------------------------- #
# 纯重排 / 编号变化允许
# --------------------------------------------------------------------------- #
def test_reorder_never_violates_locks(doc):
    reordered = _with(doc, order_ids=["c4", "c3", "c2", "c1"])
    r = client.post(
        "/api/preview",
        json={**reordered, "locked_ids": ["c1", "c2"]},
    )
    assert r.status_code == 200
    items = {it["id"]: it for it in r.json()["items"]}
    assert items["c2"]["text"] == "乙方按 [[4]] 验收后付款"
