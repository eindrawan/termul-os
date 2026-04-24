/**
 * TermulUI Component System - Entry Point
 *
 * Loads and exports all TUI components.
 * Each component is a separate file for better organization and maintainability.
 *
 * Usage:
 *   All components are automatically available as global classes after loading:
 *   - TuiComponent (base class)
 *   - TuiModal
 *   - TuiTabs
 *   - TuiDataTable
 *   - TuiDropdown
 *   - TuiToast
 *   - TuiAccordion
 *   - TuiSidebarNav
 *   - TuiRadioGroup
 */

// Export all classes globally for backward compatibility
window.TuiComponent = TuiComponent;
window.TuiModal = TuiModal;
window.TuiTabs = TuiTabs;
window.TuiDataTable = TuiDataTable;
window.TuiDropdown = TuiDropdown;
window.TuiToast = TuiToast;
window.TuiAccordion = TuiAccordion;
window.TuiSidebarNav = TuiSidebarNav;
window.TuiRadioGroup = TuiRadioGroup;

// Also export as a named object for potential ES6 module usage
window.TermulUI = {
  TuiComponent,
  TuiModal,
  TuiTabs,
  TuiDataTable,
  TuiDropdown,
  TuiToast,
  TuiAccordion,
  TuiSidebarNav,
  TuiRadioGroup
};
