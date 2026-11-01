// Durango Code SnapShot helper (macOS).
//
// A small command-line tool the desktop app runs to find the window the user
// is working in, read its accessibility tree, and watch for the "both Shift
// keys" trigger. Every command prints JSON lines on stdout and exits non-zero
// only on bad usage; failures are reported as {"ok":false,"error":"…"}.
//
//   watch-modifiers --pair shift [--interval-ms 50] [--parent-pid <pid>]
//       Polls the modifier flag state (no event tap, so no Input Monitoring
//       permission) and prints {"event":"trigger"} each time both keys of the
//       pair go down together. Exits when its parent process goes away.
//   windows [--limit 200]
//       The on-screen windows front to back and the active app's pid; the
//       app picks the window to capture.
//   ax --pid <pid> [--window-bounds x,y,w,h] [--title <t>] [--max-nodes 2000]
//      [--max-depth 40] [--deadline-ms 2500]
//       The window's accessibility tree as a flat, depth-annotated node list.
//       Frames are in global screen points; the app converts them to image
//       pixels. Stops at the deadline and prints what it has with
//       "truncated":true (at the latest 250 ms after it, even if the app hangs).
//   trigger-steps --pair shift --polls L,LR,-,...
//       Test hook: replays modifier polls through the watch-modifiers edge
//       logic and prints the indexes that would fire.
//   version
//
// Built by scripts/build-snapshot-helper.mjs. TCC (Screen Recording,
// Accessibility) attributes this process to the app that launched it.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

let helperVersion = 1

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ object: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(object),
        let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
        let line = String(data: data, encoding: .utf8)
  else {
    print("{\"ok\":false,\"error\":\"unserializable output\"}")
    return
  }
  print(line)
  fflush(stdout)
}

func fail(_ message: String, code: Int32 = 0) -> Never {
  emit(["ok": false, "error": message])
  exit(code)
}

// MARK: - Arguments

struct Arguments {
  var values: [String: [String]] = [:]

  init(_ raw: ArraySlice<String>) {
    var key: String?
    for item in raw {
      if item.hasPrefix("--") {
        key = String(item.dropFirst(2))
        if values[key!] == nil { values[key!] = [] }
      } else if let current = key {
        values[current, default: []].append(item)
        key = nil
      }
    }
  }

  func string(_ name: String) -> String? { values[name]?.last }
  func strings(_ name: String) -> [String] { values[name] ?? [] }
  func int(_ name: String, _ fallback: Int) -> Int { string(name).flatMap { Int($0) } ?? fallback }
  func doubles(_ name: String) -> [Double]? {
    guard let raw = string(name) else { return nil }
    let parts = raw.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
    return parts.count == 4 ? parts : nil
  }
}

// MARK: - watch-modifiers

// Device-dependent bits of CGEventFlags (IOKit's NX_DEVICE*KEYMASK): the low
// word tells the left and right keys of a modifier apart.
let modifierPairs: [String: (left: UInt64, right: UInt64)] = [
  "shift": (0x02, 0x04),
  "control": (0x01, 0x2000),
  "option": (0x20, 0x40),
  "command": (0x08, 0x10),
]

// Other modifiers held at the same time mean the user is typing a chord, not
// asking for a capture.
let independentModifiers: [String: CGEventFlags] = [
  "shift": .maskShift,
  "control": .maskControl,
  "option": .maskAlternate,
  "command": .maskCommand,
]

func parentAlive(_ pid: pid_t) -> Bool {
  if pid <= 1 { return true }
  if getppid() != pid { return false }
  return kill(pid, 0) == 0 || errno == EPERM
}

// One poll of the trigger. `bothDown` is the physical state of the pair (both
// keys held, whatever else is held); the caller keeps it between polls. A
// capture fires only on the transition into both-down, and only when no other
// modifier is held at that moment:
//
//   was both down | both down now | other modifier | fire | why
//   no            | no            | any            | no   | not pressed
//   no            | yes           | no             | yes  | a fresh press of the pair
//   no            | yes           | yes            | no   | part of a chord (Cmd+Shift+Shift)
//   yes           | yes           | any            | no   | still held: releasing or adding
//                 |               |                |      | Cmd/Ctrl/Opt doesn't re-trigger
//   yes           | no            | any            | no   | a key of the pair went up: re-armed
//
// So after Cmd+Shift+Shift, releasing Cmd fires nothing, and after a capture,
// pressing and releasing Cmd fires nothing; one of the pair has to go up first.
func modifierTriggerStep(wasBothDown: Bool, flags: UInt64, both: UInt64, others: CGEventFlags)
  -> (fire: Bool, bothDown: Bool)
{
  let bothDown = (flags & both) == both
  let fire = bothDown && !wasBothDown && CGEventFlags(rawValue: flags).intersection(others).isEmpty
  return (fire, bothDown)
}

func modifierPairSetup(_ args: Arguments) -> (name: String, pair: (left: UInt64, right: UInt64), others: CGEventFlags) {
  let name = args.string("pair") ?? "shift"
  guard let pair = modifierPairs[name] else { fail("unknown modifier pair: \(name)", code: 2) }
  let others = independentModifiers.filter { $0.key != name }.reduce(CGEventFlags()) { $0.union($1.value) }
  return (name, pair, others)
}

func watchModifiers(_ args: Arguments) -> Never {
  let (name, pair, others) = modifierPairSetup(args)
  let interval = max(15, min(500, args.int("interval-ms", 50)))
  let parentPid = pid_t(args.int("parent-pid", Int(getppid())))
  let both = pair.left | pair.right

  signal(SIGPIPE, SIG_IGN)
  emit(["event": "ready", "pair": name, "version": helperVersion])
  var wasBothDown = true // never fire for keys already held when the watcher starts
  var tick = 0
  while true {
    let flags = CGEventSource.flagsState(.combinedSessionState)
    let step = modifierTriggerStep(wasBothDown: wasBothDown, flags: flags.rawValue, both: both, others: others)
    if step.fire {
      emit(["event": "trigger", "pair": name, "at": Date().timeIntervalSince1970 * 1000])
    }
    wasBothDown = step.bothDown
    tick += 1
    if tick % 10 == 0 && !parentAlive(parentPid) { exit(0) }
    usleep(useconds_t(interval * 1000))
  }
}

// Test hook for modifierTriggerStep (scripts/test-snapshot.mjs): replays a
// comma-separated list of polls and prints the indexes that fire. Each poll is
// letters for the keys held: L/R the left/right key of the pair, C Command,
// O Option, T Control (when not the pair), "-" nothing. Starts as the watcher
// does, with the pair treated as already held.
func triggerSteps(_ args: Arguments) -> Never {
  let (name, pair, others) = modifierPairSetup(args)
  let generic = independentModifiers[name]!.rawValue
  let keys: [Character: UInt64] = [
    "L": pair.left | generic,
    "R": pair.right | generic,
    "C": CGEventFlags.maskCommand.rawValue | 0x08,
    "O": CGEventFlags.maskAlternate.rawValue | 0x20,
    "T": CGEventFlags.maskControl.rawValue | 0x01,
  ]
  var wasBothDown = true
  var fires: [Int] = []
  for (index, poll) in (args.string("polls") ?? "").split(separator: ",").enumerated() {
    var flags: UInt64 = 0
    for key in poll where key != "-" {
      guard let bits = keys[key] else { fail("unknown key in poll: \(key)", code: 2) }
      flags |= bits
    }
    let step = modifierTriggerStep(wasBothDown: wasBothDown, flags: flags, both: pair.left | pair.right, others: others)
    if step.fire { fires.append(index) }
    wasBothDown = step.bothDown
  }
  emit(["ok": true, "fires": fires])
  exit(0)
}

// MARK: - windows

func number(_ value: Any?) -> Double? {
  if let n = value as? NSNumber { return n.doubleValue }
  return nil
}

// The on-screen windows front to back, with the active app's pid. The app
// picks the window to capture (selectSnapShotWindow in
// src/main/snapshot-format.js) so the rules stay testable.
func windows(_ args: Arguments) -> Never {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]]
  else { fail("could not read the window list") }
  let limit = max(1, min(500, args.int("limit", 200)))
  var apps: [pid_t: NSRunningApplication?] = [:]
  var result: [[String: Any]] = []
  for info in list.prefix(limit) {
    guard let windowId = number(info[kCGWindowNumber as String]),
          let pidValue = number(info[kCGWindowOwnerPID as String]),
          let bounds = info[kCGWindowBounds as String] as? [String: Any]
    else { continue }
    let pid = pid_t(pidValue)
    if apps[pid] == nil { apps[pid] = NSRunningApplication(processIdentifier: pid) }
    let app = apps[pid] ?? nil
    result.append([
      "windowId": Int(windowId),
      "pid": Int(pid),
      "layer": Int(number(info[kCGWindowLayer as String]) ?? 0),
      "alpha": Double(number(info[kCGWindowAlpha as String]) ?? 1),
      "onScreen": (info[kCGWindowIsOnscreen as String] as? Bool) ?? true,
      "bundleId": app?.bundleIdentifier ?? "",
      "appName": app?.localizedName ?? (info[kCGWindowOwnerName as String] as? String ?? ""),
      "title": info[kCGWindowName as String] as? String ?? "",
      "bounds": [
        "x": Double(number(bounds["X"]) ?? 0),
        "y": Double(number(bounds["Y"]) ?? 0),
        "width": Double(number(bounds["Width"]) ?? 0),
        "height": Double(number(bounds["Height"]) ?? 0),
      ],
    ])
  }
  var output: [String: Any] = ["ok": true, "windows": result, "screenRecording": CGPreflightScreenCaptureAccess()]
  if let active = NSWorkspace.shared.frontmostApplication?.processIdentifier { output["activePid"] = Int(active) }
  emit(output)
  exit(0)
}

// MARK: - ax

let nodeAttributes = [
  kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
  kAXValueAttribute, kAXEnabledAttribute, kAXFocusedAttribute, kAXSelectedAttribute,
  kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute,
]

let valueLimit = 500

func axCopy(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
  var value: AnyObject?
  return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
}

func axPoint(_ value: AnyObject?) -> CGPoint? {
  guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
  var point = CGPoint.zero
  return AXValueGetValue(value as! AXValue, .cgPoint, &point) ? point : nil
}

func axSize(_ value: AnyObject?) -> CGSize? {
  guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
  var size = CGSize.zero
  return AXValueGetValue(value as! AXValue, .cgSize, &size) ? size : nil
}

func isAXError(_ value: AnyObject?) -> Bool {
  guard let value else { return true }
  if value is NSNull { return true }
  return CFGetTypeID(value) == AXValueGetTypeID() && AXValueGetType(value as! AXValue) == .axError
}

func clean(_ text: String, limit: Int) -> String {
  let collapsed = text.replacingOccurrences(of: "\u{0}", with: "")
  if collapsed.count <= limit { return collapsed }
  return String(collapsed.prefix(limit)) + "…"
}

func describeValue(_ value: AnyObject?) -> String? {
  guard !isAXError(value), let value else { return nil }
  if let text = value as? String { return text.isEmpty ? nil : clean(text, limit: valueLimit) }
  if let attributed = value as? NSAttributedString {
    return attributed.string.isEmpty ? nil : clean(attributed.string, limit: valueLimit)
  }
  if let n = value as? NSNumber { return n.stringValue }
  return nil
}

func stripAX(_ role: String) -> String {
  role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
}

func distance(_ frame: CGRect, _ bounds: CGRect) -> Double {
  abs(frame.minX - bounds.minX) + abs(frame.minY - bounds.minY)
    + abs(frame.width - bounds.width) + abs(frame.height - bounds.height)
}

// Every AX read blocks until the target app answers or the element's
// messaging timeout runs out (6 s by default), and the timeout set on one
// element doesn't carry over to the windows and children read from it. So the
// system-wide element gets a short default, and before each read the element's
// timeout is cut to the time left before the deadline: a stalled window or
// child costs at most what is left, and the tree collected so far still goes
// out before the app's kill timeout.
let axCallTimeout: Double = 0.75

struct AXBudget {
  let deadline: Date

  var remaining: TimeInterval { deadline.timeIntervalSinceNow }

  // false once the deadline has passed; the caller stops reading.
  func arm(_ element: AXUIElement) -> Bool {
    let left = remaining
    guard left > 0.01 else { return false }
    AXUIElementSetMessagingTimeout(element, Float(min(axCallTimeout, left)))
    return true
  }
}

// The nodes read so far. The traversal appends on the main thread; a watchdog
// prints whatever is here if the main thread is still stuck in an AX call
// shortly after the deadline. Whichever finishes first prints and exits while
// holding the lock, so the output is printed exactly once.
final class AXOutput {
  private let lock = NSLock()
  private var nodes: [[String: Any]] = []

  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return nodes.count
  }

  func append(_ node: [String: Any]) {
    lock.lock()
    nodes.append(node)
    lock.unlock()
  }

  func failOnce(_ message: String) -> Never {
    lock.lock()
    fail(message)
  }

  func finish(truncated: Bool, emptyError: String? = nil) -> Never {
    lock.lock()
    if nodes.isEmpty, let emptyError { fail(emptyError) }
    emit(["ok": true, "nodes": nodes, "truncated": truncated])
    exit(0)
  }
}

// nil when no window matches; throws AXTimedOut when the app doesn't answer.
struct AXTimedOut: Error {}

func matchWindow(app: AXUIElement, bounds: CGRect?, title: String?, budget: AXBudget) throws -> AXUIElement? {
  guard budget.arm(app) else { throw AXTimedOut() }
  var list: AnyObject?
  // A hung app fails here; don't spend the rest of the budget on it.
  if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &list) == .cannotComplete { throw AXTimedOut() }
  let windows = (list as? [AXUIElement]) ?? []
  if let bounds {
    var best: (AXUIElement, Double)?
    for window in windows {
      guard budget.arm(window) else { throw AXTimedOut() }
      guard let origin = axPoint(axCopy(window, kAXPositionAttribute)) else { continue }
      // Re-arm: the position read may have used most of what was left.
      guard budget.arm(window) else { throw AXTimedOut() }
      guard let size = axSize(axCopy(window, kAXSizeAttribute)) else { continue }
      let score = distance(CGRect(origin: origin, size: size), bounds)
      if best == nil || score < best!.1 { best = (window, score) }
    }
    if let best, best.1 <= 8 { return best.0 }
  }
  if let title, !title.isEmpty {
    for window in windows {
      guard budget.arm(window) else { throw AXTimedOut() }
      if (axCopy(window, kAXTitleAttribute) as? String) == title { return window }
    }
  }
  guard budget.arm(app) else { throw AXTimedOut() }
  if let focused = axCopy(app, kAXFocusedWindowAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID() {
    return (focused as! AXUIElement)
  }
  return windows.first
}

// How long after the deadline the watchdog prints the partial tree when an AX
// call ignores its timeout. The app's kill timeout must be longer than
// deadline + this (src/main/snapshot.js: 2300 ms deadline, 3000 ms kill).
let axWatchdogGrace: TimeInterval = 0.25

func accessibilityTree(_ args: Arguments) -> Never {
  guard let pidValue = args.string("pid").flatMap({ Int32($0) }) else { fail("--pid is required", code: 2) }
  guard AXIsProcessTrusted() else { fail("accessibility-denied") }
  let maxNodes = max(1, min(10000, args.int("max-nodes", 2000)))
  let maxDepth = max(1, min(200, args.int("max-depth", 40)))
  let budget = AXBudget(deadline: Date().addingTimeInterval(Double(max(100, args.int("deadline-ms", 2500))) / 1000))
  let bounds = args.doubles("window-bounds").map { CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) }

  let output = AXOutput()
  DispatchQueue.global(qos: .userInitiated).asyncAfter(wallDeadline: .now() + budget.remaining + axWatchdogGrace) {
    output.finish(truncated: true, emptyError: "ax-timeout")
  }

  AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), Float(axCallTimeout))
  let app = AXUIElementCreateApplication(pidValue)
  // Chromium and Electron apps build their tree only for assistive clients
  // that ask for it. Unsupported apps ignore the attribute.
  if budget.arm(app) {
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  }

  let found: AXUIElement?
  do {
    found = try matchWindow(app: app, bounds: bounds, title: args.string("title"), budget: budget)
  } catch {
    output.failOnce("ax-timeout")
  }
  guard let window = found else { output.failOnce("no-ax-window") }

  var truncated = false
  var stack: [(AXUIElement, Int)] = [(window, 0)]
  while let (element, depth) = stack.popLast() {
    if output.count >= maxNodes || !budget.arm(element) {
      truncated = true
      break
    }
    var raw: CFArray?
    let status = AXUIElementCopyMultipleAttributeValues(element, nodeAttributes as CFArray, AXCopyMultipleAttributeOptions(), &raw)
    guard status == .success, let values = raw as? [AnyObject], values.count == nodeAttributes.count else {
      // A node that timed out is missing with its subtree.
      if status == .cannotComplete { truncated = true }
      continue
    }
    var node: [String: Any] = ["depth": depth]
    if let role = values[0] as? String { node["role"] = stripAX(role) }
    if let subrole = values[1] as? String { node["subrole"] = stripAX(subrole) }
    if let title = describeValue(values[2]) { node["title"] = title }
    if let description = describeValue(values[3]) { node["description"] = description }
    if let value = describeValue(values[4]) { node["value"] = value }
    if let enabled = values[5] as? Bool, !enabled { node["enabled"] = false }
    if let focused = values[6] as? Bool, focused { node["focused"] = true }
    if let selected = values[7] as? Bool, selected { node["selected"] = true }
    if let origin = axPoint(values[8]), let size = axSize(values[9]) {
      node["frame"] = [origin.x, origin.y, size.width, size.height].map { Double($0) }
    }
    output.append(node)
    if depth + 1 > maxDepth {
      if !isAXError(values[10]), let children = values[10] as? [AnyObject], !children.isEmpty { truncated = true }
      continue
    }
    if !isAXError(values[10]), let children = values[10] as? [AXUIElement] {
      for child in children.reversed() { stack.append((child, depth + 1)) }
    }
  }
  if !stack.isEmpty { truncated = true }
  output.finish(truncated: truncated)
}

// MARK: - main

let argv = CommandLine.arguments
guard argv.count >= 2 else { fail("usage: durango-snapshot <watch-modifiers|windows|ax|trigger-steps|version> [options]", code: 2) }
let args = Arguments(argv.dropFirst(2))
switch argv[1] {
case "watch-modifiers": watchModifiers(args)
case "windows": windows(args)
case "ax": accessibilityTree(args)
case "trigger-steps": triggerSteps(args)
case "version": emit(["ok": true, "version": helperVersion]); exit(0)
default: fail("unknown command: \(argv[1])", code: 2)
}
