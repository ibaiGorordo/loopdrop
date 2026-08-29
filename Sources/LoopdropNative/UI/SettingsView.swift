import SwiftUI

struct SettingsView: View {
    @ObservedObject var preferences: LoopdropPreferences

    var body: some View {
        Form {
            Picker("Default clip", selection: $preferences.clipLength) {
                ForEach(ClipLengthPreset.allCases) { preset in
                    Text(preset.title).tag(preset)
                }
            }

            Picker("Default quality", selection: $preferences.quality) {
                ForEach(QualityPreset.allCases) { preset in
                    Text("\(preset.title) — \(preset.detail)").tag(preset)
                }
            }

            Toggle("Play video previews automatically", isOn: $preferences.playPreview)
            Toggle("Reveal each completed GIF in Finder", isOn: $preferences.revealOutput)

            HStack {
                Spacer()
                Button("Restore Defaults", action: preferences.restoreDefaults)
                    .accessibilityHint("Restores Loopdrop's default clip, quality, and behavior settings")
            }
        }
        .formStyle(.grouped)
        .padding(8)
        .frame(width: 430, height: 275)
        .navigationTitle("Loopdrop Settings")
    }
}
