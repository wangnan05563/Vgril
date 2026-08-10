# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['D:/code/otherProjects/21_Vgril/server.py'],
    pathex=[],
    binaries=[],
    datas=[('D:/code/otherProjects/21_Vgril/index.html', '.'), ('D:/code/otherProjects/21_Vgril/xiaoya.png', '.'), ('D:/code/otherProjects/21_Vgril/keys.example.json', '.'), ('D:/code/otherProjects/21_Vgril/dist/assets', 'assets')],
    hiddenimports=[],
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
    name='CodexQQSkin',
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
