import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { ffmpegDeviceArgs, which } from "../src/audio"

describe("which", () => {
  test("finds an executable on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "dictate-path-"))
    for (const name of ["tool", "tool.exe", "tool.cmd"]) writeFileSync(join(dir, name), "")
    const original = process.env.PATH
    process.env.PATH = [dir, original].join(delimiter)
    try {
      expect(which("tool")).toBe(true)
    } finally {
      process.env.PATH = original
    }
  })

  test("returns false for a missing binary", () => {
    expect(which("definitely-not-a-real-binary-3f9a")).toBe(false)
  })

  test("a PATH entry containing the path delimiter does not break lookup", () => {
    // On Windows every entry contains "C:\\...", which a naive ":" split would
    // shred. path.delimiter keeps them intact on either platform.
    const original = process.env.PATH
    const dir = mkdtempSync(join(tmpdir(), "dictate-path-"))
    writeFileSync(join(dir, "tool"), "")
    writeFileSync(join(dir, "tool.exe"), "")
    process.env.PATH = [dir, original].join(delimiter)
    try {
      expect(which("tool")).toBe(true)
    } finally {
      process.env.PATH = original
    }
  })
})

describe("ffmpegDeviceArgs", () => {
  test("linux uses the pulse default", () => {
    expect(ffmpegDeviceArgs("linux", undefined, undefined)).toEqual(["-f", "pulse", "-i", "default"])
    expect(ffmpegDeviceArgs("linux", "my-sink", undefined)).toEqual(["-f", "pulse", "-i", "my-sink"])
  })

  test("macOS picks an avfoundation audio index", () => {
    expect(ffmpegDeviceArgs("darwin", undefined, undefined)).toEqual(["-f", "avfoundation", "-i", ":0"])
    expect(ffmpegDeviceArgs("darwin", "2", undefined)).toEqual(["-f", "avfoundation", "-i", ":2"])
    expect(ffmpegDeviceArgs("darwin", ":1", undefined)).toEqual(["-f", "avfoundation", "-i", ":1"])
    expect(ffmpegDeviceArgs("darwin", undefined, ":3")).toEqual(["-f", "avfoundation", "-i", ":3"])
  })

  test("windows uses the literal dshow device name", () => {
    expect(ffmpegDeviceArgs("win32", undefined, undefined)).toEqual(["-f", "dshow", "-i", "audio=default"])
    expect(ffmpegDeviceArgs("win32", "Microphone (Realtek)", undefined)).toEqual([
      "-f",
      "dshow",
      "-i",
      "audio=Microphone (Realtek)",
    ])
    expect(ffmpegDeviceArgs("win32", "audio=Already", undefined)).toEqual(["-f", "dshow", "-i", "audio=Already"])
    expect(ffmpegDeviceArgs("win32", undefined, "audio=Probed")).toEqual(["-f", "dshow", "-i", "audio=Probed"])
  })
})
