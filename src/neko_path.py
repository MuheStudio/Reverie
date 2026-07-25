"""
N.E.K.O 模块路径适配补丁。

问题：N.E.K.O 内部所有模块使用相对导入（from config import / from utils import），
     期望在 N.E.K.O 包根目录下运行。
解决：在 Reverie 启动时将 neko_core/ 注入 sys.path，使 N.E.K.O 模块可被正确导入。

用法：
    from src.neko_path import setup_neko_path
    setup_neko_path()
    # 此后即可 import config / import memory.facts 等
"""
import sys
from pathlib import Path

_NEKO_ROOT = Path(__file__).resolve().parent.parent / "neko_core"
_INJECTED = False


def setup_neko_path():
    """将 N.E.K.O 根目录注入 sys.path，使内部导入正常工作。"""
    global _INJECTED
    if _INJECTED:
        return

    neko_root = str(_NEKO_ROOT)
    if neko_root not in sys.path:
        sys.path.insert(0, neko_root)
        _INJECTED = True
