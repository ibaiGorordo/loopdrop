import AppKit
import SwiftUI

struct CompactConverterView: View {
    @ObservedObject var model: LoopdropViewModel
    @ObservedObject private var preferences: LoopdropPreferences

    let chooseVideo: () -> Void
    let openSettings: () -> Void
    let closePopover: () -> Void

    @State private var isDropTargeted = false

    private let accent = Color(red: 240 / 255, green: 100 / 255, blue: 50 / 255)

    @MainActor
    init(
        model: LoopdropViewModel,
        chooseVideo: @escaping () -> Void,
        openSettings: @escaping () -> Void,
        closePopover: @escaping () -> Void
    ) {
        self.model = model
        _preferences = ObservedObject(wrappedValue: model.preferences)
        self.chooseVideo = chooseVideo
        self.openSettings = openSettings
        self.closePopover = closePopover
    }

    var body: some View {
        HStack(spacing: 10) {
            sourcePanel
                .frame(width: 148, height: 156)

            controls
                .frame(width: 232, height: 156)
        }
        .padding(10)
        .frame(width: 410, height: 176)
        .background(Color(nsColor: .windowBackgroundColor))
        .onDrop(
            of: ["public.file-url"],
            isTargeted: $isDropTargeted,
            perform: acceptDrop
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Loopdrop mini converter")
    }

    @ViewBuilder
    private var sourcePanel: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor))
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(
                    isDropTargeted ? accent : Color(nsColor: .separatorColor),
                    style: StrokeStyle(
                        lineWidth: isDropTargeted ? 2 : 1,
                        dash: model.inputURL == nil ? [5, 4] : []
                    )
                )

            if let inputURL = model.inputURL {
                VStack(spacing: 4) {
                    ZStack {
                        PlayerPreview(player: model.previewPlayer)
                            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))

                        Button(action: model.togglePreviewPlayback) {
                            Image(systemName: model.isPreviewPlaying ? "pause.fill" : "play.fill")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(.white)
                                .frame(width: 28, height: 28)
                                .background(.black.opacity(0.48), in: Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(model.isPreviewPlaying ? "Pause preview" : "Play preview")
                    }
                    .frame(height: 119)

                    HStack(spacing: 4) {
                        VStack(alignment: .leading, spacing: 0) {
                            Text(inputURL.lastPathComponent)
                                .font(.system(size: 10, weight: .medium))
                                .lineLimit(1)
                                .truncationMode(.middle)
                            if let description = model.inputDescription {
                                Text(description)
                                    .font(.system(size: 8))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)

                        Button(action: model.clearInput) {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .disabled(model.isConverting)
                        .accessibilityLabel("Clear selected video")
                    }
                    .frame(height: 25)
                }
                .padding(6)
            } else {
                VStack(spacing: 7) {
                    Image(systemName: "film.stack")
                        .font(.system(size: 24, weight: .light))
                        .foregroundStyle(isDropTargeted ? accent : .secondary)
                        .accessibilityHidden(true)
                    Text(isDropTargeted ? "Drop to select" : "Drop a video")
                        .font(.system(size: 11, weight: .semibold))
                    Button("Choose Video", action: chooseVideo)
                        .controlSize(.small)
                        .disabled(model.isConverting)
                        .accessibilityHint("Opens a file picker without closing this mini converter")
                }
            }
        }
        .animation(.easeOut(duration: 0.12), value: isDropTargeted)
    }

    private var controls: some View {
        VStack(spacing: 6) {
            HStack(spacing: 7) {
                Text("LOOPDROP")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .tracking(0.8)
                    .foregroundStyle(accent)
                Spacer()
                iconButton("gearshape", label: "Open settings", action: openSettings)
                iconButton("xmark", label: "Close mini converter", action: closePopover)
            }
            .frame(height: 20)

            presetRow(label: "CLIP") {
                Picker("Clip length", selection: $preferences.clipLength) {
                    ForEach(ClipLengthPreset.allCases) { preset in
                        Text(preset.title).tag(preset)
                    }
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .disabled(model.isConverting)
                .accessibilityLabel("Clip length")
            }

            presetRow(label: "SIZE") {
                Picker("GIF quality", selection: $preferences.quality) {
                    ForEach(QualityPreset.allCases) { preset in
                        Text(preset.title).tag(preset)
                    }
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .disabled(model.isConverting)
                .accessibilityLabel("GIF quality")
            }

            Button(action: model.isConverting ? model.cancelConversion : model.startConversion) {
                HStack(spacing: 6) {
                    Image(systemName: model.isConverting ? "xmark" : "sparkles")
                    Text(model.isConverting ? "Cancel" : "Create GIF")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.regular)
            .tint(model.isConverting ? .red : accent)
            .disabled(model.activity == .cancelling || (!model.isConverting && !model.canConvert))
            .accessibilityHint(model.isConverting
                ? "Stops the conversion and keeps the selected video"
                : "Creates a GIF in your Downloads folder")

            status
                .frame(height: 20)
        }
        .controlSize(.small)
    }

    private func presetRow<Content: View>(
        label: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        HStack(spacing: 5) {
            Text(label)
                .font(.system(size: 8, weight: .bold, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(width: 30, alignment: .leading)
            content()
                .frame(maxWidth: .infinity)
        }
        .frame(height: 25)
    }

    @ViewBuilder
    private var status: some View {
        if model.isConverting {
            HStack(spacing: 7) {
                ProgressView(value: model.progress)
                    .progressViewStyle(.linear)
                    .accessibilityLabel("Conversion progress")
                    .accessibilityValue("\(Int(model.progress * 100)) percent")
                Text("\(Int(model.progress * 100))%")
                    .monospacedDigit()
                    .frame(width: 30, alignment: .trailing)
            }
        } else if model.outputURL != nil {
            HStack(spacing: 6) {
                Label("GIF ready", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .lineLimit(1)
                Spacer()
                Button("Show in Finder", action: model.revealOutput)
                    .buttonStyle(.link)
                    .accessibilityHint("Reveals the completed GIF")
            }
            .font(.system(size: 10, weight: .medium))
        } else {
            HStack(spacing: 5) {
                Image(systemName: statusSymbol)
                    .foregroundStyle(statusColor)
                    .accessibilityHidden(true)
                Text(model.displayedStatusMessage)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(model.displayedStatusMessage)
                Spacer(minLength: 0)
            }
            .font(.system(size: 10))
            .foregroundStyle(.secondary)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Status: \(model.displayedStatusMessage)")
        }
    }

    private var statusSymbol: String {
        switch model.activity {
        case .probing: "ellipsis.circle"
        case .failed: "exclamationmark.triangle.fill"
        default: "circle.fill"
        }
    }

    private var statusColor: Color {
        model.activity == .failed ? .red : .secondary
    }

    private func iconButton(
        _ systemName: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 10, weight: .semibold))
                .frame(width: 18, height: 18)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .accessibilityLabel(label)
    }

    private func acceptDrop(_ providers: [NSItemProvider]) -> Bool {
        guard !model.isConverting,
              let provider = providers.first(where: {
                  $0.hasItemConformingToTypeIdentifier("public.file-url")
              }) else {
            return false
        }

        provider.loadItem(forTypeIdentifier: "public.file-url", options: nil) { item, _ in
            let url: URL?
            if let itemURL = item as? URL {
                url = itemURL
            } else if let itemURL = item as? NSURL {
                url = itemURL as URL
            } else if let data = item as? Data {
                url = URL(dataRepresentation: data, relativeTo: nil)
            } else if let string = item as? String {
                url = URL(string: string)
            } else {
                url = nil
            }

            guard let url else { return }
            Task { @MainActor in
                model.acceptInput(url)
            }
        }
        return true
    }
}
