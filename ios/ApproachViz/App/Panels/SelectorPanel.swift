import ComposableArchitecture
import SwiftUI
import SwiftUIIntrospect

struct NativeSelectorPanel: View {
    private enum SelectorSection: String, CaseIterable, Identifiable {
        case airports
        case approaches

        var id: String { rawValue }

        var title: String {
            switch self {
            case .airports:
                return "Airports"
            case .approaches:
                return "Approaches"
            }
        }
    }

    let store: StoreOf<AppFeature>
    let onClose: () -> Void
    @FocusState private var isAirportFilterFocused: Bool
    @State private var activeSection: SelectorSection = .approaches

    var body: some View {
        NativePanelContainer(title: "Select Scene", onClose: onClose) {
            VStack(alignment: .leading, spacing: 14) {
                Picker("Selector section", selection: $activeSection) {
                    ForEach(SelectorSection.allCases) { section in
                        Text(section.title).tag(section)
                    }
                }
                .pickerStyle(.segmented)

                switch activeSection {
                case .airports:
                    airportSection
                case .approaches:
                    approachSection
                }
            }
        }
        .onAppear {
            syncActiveSectionWithCurrentSelection()
        }
        .onChange(of: store.selectedAirportID) { _, _ in
            syncActiveSectionWithCurrentSelection()
        }
    }

    private var airportSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(
                "Filter airports",
                text: Binding(
                    get: { store.airportFilter },
                    set: { store.send(.setAirportFilter($0)) }
                )
            )
            .textFieldStyle(.roundedBorder)
            .focused($isAirportFilterFocused)
            .modifier(AirportFilterFieldModifier())

            SectionLabel("Airports")
            if store.filteredAirports.isEmpty {
                Text("No airports match the current filter.")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.58))
            } else {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(store.displayedAirports) { airport in
                        SelectorRow(
                            title: airport.id,
                            subtitle: airport.label,
                            isSelected: airport.id == store.selectedAirportID
                        ) {
                            dismissKeyboard()
                            store.send(.airportSelected(airport.id))
                            activeSection = .approaches
                        }
                    }
                }
                if store.filteredAirports.count > store.displayedAirports.count {
                    Text("Showing first \(store.displayedAirports.count) matches. Keep typing to narrow the list.")
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.52))
                }
            }
        }
    }

    private var approachSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let selectedAirportID = store.selectedAirportID {
                HStack(alignment: .center, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(selectedAirportID)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                        Text(store.sceneTitleContext?.airportLabel ?? "Selected airport")
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.58))
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Button("Change Airport") {
                        activeSection = .airports
                        isAirportFilterFocused = true
                    }
                    .buttonStyle(.borderless)
                    .platformPointerButton()
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.82))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.white.opacity(0.04))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.05))
                )
            }

            SectionLabel("Approaches")
            if store.approaches.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Select an airport to load procedures.")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.58))
                    Button("Browse Airports") {
                        activeSection = .airports
                        isAirportFilterFocused = true
                    }
                    .buttonStyle(.borderedProminent)
                    .platformPointerButton()
                    .tint(Color.white.opacity(0.14))
                }
            } else {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(store.approaches) { approach in
                        SelectorRow(
                            title: approach.procedureID,
                            subtitle: approach.displaySubtitle,
                            isSelected: approach.procedureID == store.selectedApproachID,
                            compactTitle: true
                        ) {
                            dismissKeyboard()
                            store.send(.approachSelected(approach.procedureID))
                        }
                    }
                }
            }
        }
    }

    private func dismissKeyboard() {
        isAirportFilterFocused = false
    }

    private func syncActiveSectionWithCurrentSelection() {
        activeSection = store.selectedAirportID == nil ? .airports : .approaches
    }
}

private struct SelectorRow: View {
    let title: String
    let subtitle: String
    let isSelected: Bool
    var compactTitle = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(compactTitle ? .subheadline.weight(.semibold) : .headline)
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.62))
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.85))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(isSelected ? Color.white.opacity(0.12) : Color.white.opacity(0.04))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(isSelected ? Color.white.opacity(0.16) : Color.white.opacity(0.05))
            )
        }
        .buttonStyle(.plain)
        .platformPointerButton()
    }
}

private struct AirportFilterFieldModifier: ViewModifier {
    func body(content: Content) -> some View {
        #if os(iOS)
        content
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled(true)
            .introspect(.textField, on: .iOS(.v18, .v26)) { textField in
                textField.autocapitalizationType = .none
                textField.autocorrectionType = .no
                textField.smartDashesType = .no
                textField.smartQuotesType = .no
                textField.spellCheckingType = .no
            }
        #else
        content
        #endif
    }
}
