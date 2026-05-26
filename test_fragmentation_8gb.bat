@echo off
setlocal enabledelayedexpansion

:: Test: reproduce continuation allocation descriptor with non-sector-aligned length
:: Strategy for 8GB volume:
::   1. Fill 8GB volume with large filler files (~7.5GB)
::   2. Create ~12000 small 4KB files in remaining space (~48MB)
::   3. Delete filler files (7.5GB contiguous free)
::   4. Create one big filler2 to eat contiguous space (~7.3GB)
::   5. Delete every other small file -> only 4KB holes remain
::   6. Create bigfile -> forced into 4KB fragments -> continuation ADs
::
:: ~6000 fragments -> 6000-233 inline = 5767 in continuation
:: 5767 mod 253 = 91 remaining ADs, extLength = 91*8+16 = 744, not sector-aligned
::
:: Run from an 8GB UDF volume.

set TESTDIR=%~dp0_udf_frag_test_8gb
set SMALL_COUNT=12000

if exist "%TESTDIR%" (
    echo Cleaning previous test...
    rmdir /s /q "%TESTDIR%"
)
mkdir "%TESTDIR%"

:: --- Build temp blocks in %TEMP% ---
set TMPBLOCK=%TEMP%\udf_test_4k.tmp
set TMP1MB=%TEMP%\udf_test_1mb.tmp
set TMP256MB=%TEMP%\udf_test_256mb.tmp

echo === Building temp files ===

:: 4KB block
< nul set /p=""> "%TMPBLOCK%"
for /L %%i in (1,1,64) do (
    echo 0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDE>> "%TMPBLOCK%"
)

:: 1MB block by doubling: 4K -> 8K -> 16K -> ... -> 1MB (8 doublings)
copy /y "%TMPBLOCK%" "%TMP1MB%" > nul
for /L %%i in (1,1,8) do (
    copy /b "%TMP1MB%" + "%TMP1MB%" "%TMP1MB%.2" > nul
    move /y "%TMP1MB%.2" "%TMP1MB%" > nul
)
echo   1MB temp block ready.

:: 256MB block by doubling from 1MB: 1->2->4->8->16->32->64->128->256 (8 doublings)
copy /y "%TMP1MB%" "%TMP256MB%" > nul
for /L %%i in (1,1,8) do (
    copy /b "%TMP256MB%" + "%TMP256MB%" "%TMP256MB%.2" > nul 2>&1
    if !errorlevel! neq 0 (
        del "%TMP256MB%.2" 2> nul
        echo   Could not build 256MB block (disk full?). Using smaller block.
        goto :fill_vol
    )
    move /y "%TMP256MB%.2" "%TMP256MB%" > nul
)
echo   256MB temp block ready.

:: ============================================================
:fill_vol
echo.
echo === Step 1: Fill volume with large filler files ===
echo   Creating 256MB chunks...
set FILLER_NUM=0
:filler_loop
set /a FILLER_NUM+=1
copy /y "%TMP256MB%" "%TESTDIR%\filler!FILLER_NUM!.tmp" > nul 2>&1
if !errorlevel! neq 0 (
    del "%TESTDIR%\filler!FILLER_NUM!.tmp" 2> nul
    echo   Created !FILLER_NUM! filler files (256MB each) before reaching volume limit.
    goto :fill_small
)
if !FILLER_NUM! geq 31 goto :fill_small
goto :filler_loop

:fill_small
:: ============================================================
echo.
echo === Step 2: Create %SMALL_COUNT% small 4KB files ===
for /L %%i in (1,1,%SMALL_COUNT%) do (
    copy /y "%TMPBLOCK%" "%TESTDIR%\s%%i.tmp" > nul 2>&1
    if !errorlevel! neq 0 (
        echo   Disk full at %%i small files.
        set SMALL_COUNT=%%i
        goto :del_fillers
    )
    set /a MOD=%%i %% 2000
    if !MOD! equ 0 echo   Created %%i / %SMALL_COUNT% small files...
)

:: ============================================================
:del_fillers
echo.
echo === Step 3: Delete filler files (free contiguous space) ===
del "%TESTDIR%\filler*.tmp" 2> nul
echo   Done. Freed ~!FILLER_NUM! x 256MB.

:: ============================================================
echo.
echo === Step 4: Re-fill contiguous space with one big file ===
echo   Doubling from 1MB to consume most remaining free space...
copy /y "%TMP1MB%" "%TESTDIR%\filler_big.tmp" > nul
for /L %%i in (1,1,16) do (
    copy /b "%TESTDIR%\filler_big.tmp" + "%TESTDIR%\filler_big.tmp" "%TESTDIR%\filler_big2.tmp" > nul 2>&1
    if !errorlevel! neq 0 (
        del "%TESTDIR%\filler_big2.tmp" 2> nul
        goto :frag_step
    )
    move /y "%TESTDIR%\filler_big2.tmp" "%TESTDIR%\filler_big.tmp" > nul
    echo   Doubled to next size (doubling %%i/16)...
)

:frag_step
echo   Contiguous space consumed.

:: ============================================================
echo.
echo === Step 5: Delete every other small file (create 4KB holes) ===
for /L %%i in (1,2,%SMALL_COUNT%) do (
    del "%TESTDIR%\s%%i.tmp" 2> nul
)
echo   Done. Only 4KB holes remain as free space.

:: ============================================================
echo.
echo === Step 6: Write file into fragmented space ===
echo   Must land in 4KB fragments (no contiguous space)...
echo   This triggers continuation allocation descriptors.

:: Write by appending 4KB chunks one at a time - each goes into a hole
< nul set /p=""> "%TESTDIR%\bigfile.dat"
set CHUNKS=0
:chunk_loop
set /a CHUNKS+=1
type "%TMPBLOCK%" >> "%TESTDIR%\bigfile.dat" 2> nul
if !errorlevel! neq 0 goto :chunk_done
set /a MOD=!CHUNKS! %% 500
if !MOD! equ 0 echo   Written !CHUNKS! x 4KB chunks...
if !CHUNKS! geq 6500 goto :chunk_done
goto :chunk_loop

:chunk_done
echo   bigfile.dat = !CHUNKS! x 4KB = !CHUNKS! fragments

:: ============================================================
echo.
echo === Step 7: Modify file (trigger write/pack path) ===
echo test_append >> "%TESTDIR%\bigfile.dat"
echo   Done.

:: ============================================================
echo.
echo === Cleanup temp files ===
del "%TMPBLOCK%" 2> nul
del "%TMP1MB%" 2> nul
del "%TMP256MB%" 2> nul

echo.
echo === Test complete ===
echo If no BSOD/assert occurred, the fix works.
echo.
echo To clean up: rmdir /s /q "%TESTDIR%"

endlocal
