import Foundation
import Security

guard CommandLine.arguments.count == 4 else { exit(64) }
let operation = CommandLine.arguments[1]
let service = CommandLine.arguments[2]
let account = CommandLine.arguments[3]

let query: [CFString: Any] = [
  kSecClass: kSecClassGenericPassword,
  kSecAttrService: service,
  kSecAttrAccount: account,
]
if operation == "read" {
  var readQuery = query
  readQuery[kSecReturnData] = true
  readQuery[kSecMatchLimit] = kSecMatchLimitOne
  var result: CFTypeRef?
  let status = SecItemCopyMatching(readQuery as CFDictionary, &result)
  guard status == errSecSuccess, let data = result as? Data else { exit(1) }
  FileHandle.standardOutput.write(data)
  exit(0)
}

if operation == "delete" {
  let status = SecItemDelete(query as CFDictionary)
  exit(status == errSecSuccess || status == errSecItemNotFound ? 0 : 1)
}

guard operation == "write" else { exit(64) }
let secret = FileHandle.standardInput.readDataToEndOfFile()
guard !secret.isEmpty && secret.count <= 16_384 else { exit(65) }
let update: [CFString: Any] = [kSecValueData: secret]
let updateStatus = SecItemUpdate(query as CFDictionary, update as CFDictionary)

if updateStatus == errSecSuccess { exit(0) }
guard updateStatus == errSecItemNotFound else { exit(1) }

var addition = query
addition[kSecValueData] = secret
exit(SecItemAdd(addition as CFDictionary, nil) == errSecSuccess ? 0 : 1)
