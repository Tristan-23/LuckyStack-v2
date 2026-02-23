import { faCaretDown, faCheck } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useState, useRef, useEffect } from "react";

type DropdownItem = string | number;

interface DropdownProps {
  items: DropdownItem[];
  itemsPlaceholder?: string[]; // The nice text (e.g., "Open")
  onChange?: (value: DropdownItem) => void;
  placeholder?: string; // The text to show when nothing is selected
  value?: DropdownItem;    // The actual code value (e.g., "OPEN")
  className?: string; // Allow custom classes from parent
}

export default function Dropdown({
  items,
  itemsPlaceholder,
  onChange,
  placeholder,
  value,
  className = "",
}: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [dropdownRef]);

  if (items.length === 0) return null;

  const getDisplayLabel = (val: DropdownItem): string => {
    const index = items.indexOf(val);
    if (index !== -1 && itemsPlaceholder?.[index]) {
      return itemsPlaceholder[index];
    }
    return String(val);
  };

  const isValueSelected = value !== undefined && items.includes(value);
  const currentLabel = isValueSelected ? getDisplayLabel(value) : placeholder;

  return (
    <div
      ref={dropdownRef}
      className={`
        dropdown
        relative flex items-center justify-between gap-3 
        p-2 min-w-[140px] cursor-pointer select-none rounded-md 
        bg-container1 border border-container1-border transition-colors hover:bg-container1-hover
        ${className}
      `}
      onClick={() => {
        setIsOpen((prev) => !prev);
      }}
    >
      {/* Current Selection / Title */}
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3"
      >
        <span className={`text-sm ${isValueSelected ? "text-title font-medium" : "text-common"}`}>
          {currentLabel}
        </span>

        <FontAwesomeIcon
          icon={faCaretDown}
          className={`text-xs text-common transition-transform duration-300 ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {/* Dropdown Menu */}
      <div
        className={`
          absolute left-0 top-full z-50 mt-1 w-full min-w-[140px] origin-top rounded-md 
          border border-container1-border bg-container1 shadow-lg 
          transition-all duration-200 ease-out
          ${isOpen ? "opacity-100 scale-100 translate-y-0" : "opacity-0 scale-95 -translate-y-2 pointer-events-none"}
        `}
      >
        <div className="flex flex-col p-1 max-h-60 overflow-y-auto">
          {items.map((item, index) => {
            const isSelected = item === value;
            const label = itemsPlaceholder?.[index] ?? String(item);

            return (
              <button
                key={String(item)}
                type="button"
                className={`
                  dropdown
                  flex items-center justify-between rounded-sm px-2 py-1.5 text-sm transition-colors
                  cursor-pointer
                  ${isSelected ? "bg-primary/10 text-primary font-medium" : "hover:bg-container1-hover text-title"}
                `}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange?.(item);
                  setIsOpen(false);
                }}
              >
                <span>{label}</span>
                {/* Optional: Add a checkmark for the selected item */}
                {isSelected && <FontAwesomeIcon icon={faCheck} className="text-xs ml-2" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}