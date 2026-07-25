# -*- coding: utf-8 -*-
# Copyright 2025-2026 Project N.E.K.O. Team
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#
# -- 修改说明 --
# Modified by Muhe Studio in 2026.
# Changes: 集成至 Reverie 桌面 AI 伴侣系统；调整模块路径；本地化运行。
# 详见 src/neko_core/NEKO_MODIFICATIONS.md
# See the License for the specific language governing permissions and
# limitations under the License.

"""Main Routers Package.

Submodules are intentionally not imported eagerly here. Several router modules
pull in optional dependencies, and importing the package should never fail just
because one optional route is unavailable in the current environment.
"""

__all__ = []
