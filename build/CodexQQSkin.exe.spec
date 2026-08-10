# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_submodules

hiddenimports = ['uvicorn.logging', 'uvicorn.loops.asyncio', 'uvicorn.protocols.http.auto', 'uvicorn.protocols.websockets.auto', 'uvicorn.workers']
hiddenimports += collect_submodules('fastapi')
hiddenimports += collect_submodules('starlette')
hiddenimports += collect_submodules('pydantic')
hiddenimports += collect_submodules('pydantic_core')
hiddenimports += collect_submodules('uvicorn')
hiddenimports += collect_submodules('anyio')
hiddenimports += collect_submodules('h11')
hiddenimports += collect_submodules('click')


a = Analysis(
    ['D:\\code\\otherProjects\\21_Vgril\\run_asgi.py'],
    pathex=[],
    binaries=[],
    datas=[('D:\\code\\otherProjects\\21_Vgril\\index.html', '.'), ('D:\\code\\otherProjects\\21_Vgril\\xiaoya.png', '.'), ('D:\\code\\otherProjects\\21_Vgril\\keys.example.json', '.'), ('D:\\code\\otherProjects\\21_Vgril\\dist\\assets', 'assets')],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='CodexQQSkin.exe',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
