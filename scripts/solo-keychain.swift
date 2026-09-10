import Foundation
import Security
import Darwin
import AppKit

// This small, stable executable owns the credential. Node, shells and browser
// executables are not added to its Keychain access control list.
let service = "annotation-pipeline.solo"
let account = "niuyuhang"
let origin = "https://solo2.jzxhnh.com"
let label = "SOLO 登录 · solo2.jzxhnh.com · niuyuhang"
let maxPasswordBytes = 4096

struct CredentialError: Error {
    let code: String
    let message: String
}

func emit(_ object: [String: Any], to handle: FileHandle = .standardOutput) {
    if let bytes = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
        handle.write(bytes)
        handle.write(Data([10]))
    }
}

func keychainError(_ status: OSStatus) -> CredentialError {
    switch status {
    case errSecItemNotFound:
        return CredentialError(code: "credential_missing", message: "尚未保存 SOLO 密码，请打开本机 SOLO 密码保存窗口")
    case errSecInteractionNotAllowed, errSecInteractionRequired, errSecAuthFailed, errSecUserCanceled:
        return CredentialError(code: "keychain_locked_or_denied", message: "钥匙串已锁定或访问未获允许，请在本机解锁或确认此助手")
    default:
        return CredentialError(code: "keychain_unavailable", message: "钥匙串操作未完成（系统状态 \(status)）")
    }
}

func query() -> [String: Any] {
    // SecItem defaults to the file-based user Keychain. Do not opt into a
    // shared access group, synchronization or the System Keychain.
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
    ]
}

func withoutInteraction<T>(_ operation: () throws -> T) throws -> T {
    var wasAllowed = DarwinBoolean(false)
    let existing = SecKeychainGetUserInteractionAllowed(&wasAllowed)
    guard existing == errSecSuccess else { throw keychainError(existing) }
    let disabled = SecKeychainSetUserInteractionAllowed(false)
    guard disabled == errSecSuccess else { throw keychainError(disabled) }
    defer { SecKeychainSetUserInteractionAllowed(wasAllowed.boolValue) }
    return try operation()
}

func stored() throws -> Bool {
    try withoutInteraction {
        var attributes = query()
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        // No kSecReturnData: a routine status query never reads the password.
        let status = SecItemCopyMatching(attributes as CFDictionary, nil)
        if status == errSecItemNotFound { return false }
        guard status == errSecSuccess else { throw keychainError(status) }
        return true
    }
}

func hiddenPassword(_ prompt: String) throws -> Data {
    guard isatty(STDIN_FILENO) == 1 else {
        throw CredentialError(code: "interactive_terminal_required", message: "请在本机交互终端输入密码，不能通过命令参数或管道传入")
    }
    var bytes = [CChar](repeating: 0, count: maxPasswordBytes + 1)
    defer { _ = bytes.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) } }
    let value = bytes.withUnsafeMutableBufferPointer { buffer in
        readpassphrase(prompt, buffer.baseAddress!, buffer.count, RPP_REQUIRE_TTY | RPP_ECHO_OFF)
    }
    guard value != nil else {
        throw CredentialError(code: "input_cancelled", message: "已取消密码输入")
    }
    let length = bytes.withUnsafeBufferPointer { strnlen($0.baseAddress!, $0.count) }
    guard length > 0 && length < maxPasswordBytes else {
        throw CredentialError(code: "invalid_password", message: "密码不能为空或超过允许长度")
    }
    return bytes.withUnsafeBytes { Data($0.prefix(length)) }
}

func save(password: Data) throws {
    guard !password.isEmpty && password.count < maxPasswordBytes else {
        throw CredentialError(code: "invalid_password", message: "密码不能为空或超过允许长度")
    }
    var attributes = query()
    attributes[kSecValueData as String] = password
    attributes[kSecAttrLabel as String] = label
    attributes[kSecAttrDescription as String] = "仅用于用户已授权的 SOLO 自动登录"
    // No kSecAttrAccess override: macOS trusts the creating helper for secret
    // reads. In particular, never use security -A or add a browser/shell ACL.
    let result = SecItemAdd(attributes as CFDictionary, nil)
    if result == errSecDuplicateItem {
        let changes = [kSecValueData as String: password, kSecAttrLabel as String: label] as [String: Any]
        let updated = SecItemUpdate(query() as CFDictionary, changes as CFDictionary)
        guard updated == errSecSuccess else { throw keychainError(updated) }
    } else if result != errSecSuccess {
        throw keychainError(result)
    }
}

func saveInTerminal() throws {
    var password = try hiddenPassword("SOLO 密码（输入不显示）：")
    defer { password.resetBytes(in: 0..<password.count) }
    var confirmation = try hiddenPassword("再次输入 SOLO 密码：")
    defer { confirmation.resetBytes(in: 0..<confirmation.count) }
    guard password == confirmation else {
        throw CredentialError(code: "password_mismatch", message: "两次密码不一致，未保存")
    }
    try save(password: password)
    emit(["stored": true])
}

@MainActor
func saveDialog() {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    application.finishLaunching()

    let alert = NSAlert()
    alert.messageText = "保存 SOLO 登录密码"
    alert.informativeText = "网站：solo2.jzxhnh.com\n账号：niuyuhang\n密码将保存在这台 Mac 的钥匙串，供已授权的自动登录使用。"
    alert.alertStyle = .informational
    let saveButton = alert.addButton(withTitle: "保存")
    saveButton.keyEquivalent = "\r"
    let cancelButton = alert.addButton(withTitle: "取消")
    cancelButton.keyEquivalent = "\u{1b}"

    let content = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 156))
    let passwordLabel = NSTextField(labelWithString: "SOLO 密码")
    passwordLabel.frame = NSRect(x: 0, y: 134, width: 360, height: 18)
    let passwordField = NSSecureTextField(frame: NSRect(x: 0, y: 104, width: 360, height: 26))
    passwordField.placeholderString = "请输入 SOLO 密码"
    let confirmationLabel = NSTextField(labelWithString: "确认密码")
    confirmationLabel.frame = NSRect(x: 0, y: 80, width: 360, height: 18)
    let confirmationField = NSSecureTextField(frame: NSRect(x: 0, y: 50, width: 360, height: 26))
    confirmationField.placeholderString = "请再次输入 SOLO 密码"
    let feedback = NSTextField(wrappingLabelWithString: "")
    feedback.frame = NSRect(x: 0, y: 0, width: 360, height: 44)
    feedback.textColor = .systemRed
    feedback.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
    for view in [passwordLabel, passwordField, confirmationLabel, confirmationField, feedback] {
        content.addSubview(view)
    }
    alert.accessoryView = content
    alert.window.title = "SOLO 密码保存"
    alert.window.initialFirstResponder = passwordField
    passwordField.nextKeyView = confirmationField
    confirmationField.nextKeyView = saveButton
    defer {
        passwordField.stringValue = ""
        confirmationField.stringValue = ""
    }

    application.activate(ignoringOtherApps: true)
    while true {
        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else {
            emit(["stored": false, "cancelled": true])
            return
        }
        var password = Data(passwordField.stringValue.utf8)
        defer { password.resetBytes(in: 0..<password.count) }
        var confirmation = Data(confirmationField.stringValue.utf8)
        defer { confirmation.resetBytes(in: 0..<confirmation.count) }
        if password.isEmpty || confirmation.isEmpty {
            feedback.stringValue = "请填写密码和确认密码。"
            alert.window.initialFirstResponder = password.isEmpty ? passwordField : confirmationField
            continue
        }
        if password.count >= maxPasswordBytes || confirmation.count >= maxPasswordBytes {
            feedback.stringValue = "密码超过允许长度，请重新输入。"
            alert.window.initialFirstResponder = passwordField
            continue
        }
        if password != confirmation {
            feedback.stringValue = "两次密码不一致，请核对后重新保存。"
            alert.window.initialFirstResponder = confirmationField
            continue
        }
        do {
            try save(password: password)
            emit(["stored": true])
            return
        } catch let error as CredentialError {
            // Fixed error messages contain no typed values. Keep the fields
            // available for correction or retry after a local Keychain prompt.
            feedback.stringValue = error.message
        } catch {
            feedback.stringValue = "钥匙串保存未完成，请稍后重试。"
        }
    }
}

func readForLogin() throws {
    // Only a dedicated inherited pipe/socket is accepted. Neither stdout nor
    // a regular file can be used for the secret response.
    var output = stat()
    guard fstat(3, &output) == 0,
          [S_IFIFO, S_IFSOCK].contains(output.st_mode & S_IFMT),
          isatty(3) == 0 else {
        throw CredentialError(code: "private_channel_required", message: "凭据读取仅供自动登录模块的内存管道调用")
    }
    var password: Data = try withoutInteraction {
        var attributes = query()
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        attributes[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &result)
        guard status == errSecSuccess else { throw keychainError(status) }
        guard let bytes = result as? Data, !bytes.isEmpty, bytes.count < maxPasswordBytes else {
            throw CredentialError(code: "invalid_credential", message: "已存凭据格式无效，请重新保存")
        }
        return bytes
    }
    defer { password.resetBytes(in: 0..<password.count) }
    var offset = 0
    try password.withUnsafeBytes { buffer in
        while offset < buffer.count {
            let count = Darwin.write(3, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else {
                throw CredentialError(code: "credential_channel_closed", message: "自动登录凭据通道已关闭")
            }
            offset += count
        }
    }
}

do {
    guard CommandLine.arguments.count <= 2 else {
        throw CredentialError(code: "usage", message: "用法：--save-dialog | --save | --status；密码不要写入命令参数")
    }
    switch CommandLine.arguments.dropFirst().first ?? "--save-dialog" {
    case "--save-dialog": MainActor.assumeIsolated { saveDialog() }
    case "--save": try saveInTerminal()
    case "--status": emit(["stored": try stored()])
    case "--read-for-login": try readForLogin()
    case "--contract": emit(["service": service, "account": account, "origin": origin, "secretChannel": "inherited-pipe-3"])
    default: throw CredentialError(code: "usage", message: "用法：--save-dialog | --save | --status")
    }
} catch let error as CredentialError {
    emit(["error": error.code, "message": error.message], to: .standardError)
    exit(1)
} catch {
    emit(["error": "keychain_unavailable", "message": "钥匙串操作未完成"], to: .standardError)
    exit(1)
}
