@echo off
rem Double-click to completely shut down Veritas.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1"
