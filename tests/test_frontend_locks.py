"""前端条款锁定（定稿保护）回归测试的 pytest 封装。

用例本体在 tests/test_lock_ownership.js：用最小 DOM 桩在 Node 虚拟机中加载
真实的 app/static/app.js，覆盖锁定集合的内存级生命周期（换稿 / 恢复清空、
存档快照不含锁定、切换不改正文与复核）、含失效引用不能锁定、写稿与保存请求
随附锁定集合、后端 409 整次拒绝（草稿 / 身份上界 / 复核不变）、复制允许且
副本不锁定、成功回包按最新锁定集合复核（写稿等待期间切换锁定，违例整次不安装）
以及旧响应不得写回新稿的请求归属。
这里通过 node --test 运行它；环境没有 Node 时跳过（后端接口测试不受影响）。
"""

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.mark.skipif(shutil.which("node") is None, reason="需要 Node 运行前端单测")
def test_lock_ownership_frontend():
    r = subprocess.run(
        ["node", "--test", str(ROOT / "tests" / "test_lock_ownership.js")],
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, r.stdout + r.stderr
