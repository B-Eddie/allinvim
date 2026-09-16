// AllinVim site interactions: mobile nav, scroll reveal, demo mode chip.
(() => {
  "use strict";

  // Mobile nav toggle.
  const toggle = document.querySelector(".nav-toggle");
  const mobile = document.querySelector(".nav-mobile");
  if (toggle && mobile) {
    toggle.addEventListener("click", () => {
      const open = mobile.hasAttribute("hidden");
      if (open) {
        mobile.removeAttribute("hidden");
        toggle.setAttribute("aria-expanded", "true");
      } else {
        mobile.setAttribute("hidden", "");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
    mobile.querySelectorAll("a").forEach((a) =>
      a.addEventListener("click", () => {
        mobile.setAttribute("hidden", "");
        toggle.setAttribute("aria-expanded", "false");
      })
    );
    // Safety: never leave the mobile menu open when resizing up to desktop.
    window.addEventListener("resize", () => {
      if (window.matchMedia("(min-width: 901px)").matches) {
        mobile.setAttribute("hidden", "");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  // Gentle reveal-on-scroll (respects reduced motion via CSS fallback).
  const revealables = document.querySelectorAll(
    ".card, .code-pane, .install, .faq, .final"
  );
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.style.transition = "opacity .4s ease";
            entry.target.style.opacity = "1";
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.08 }
    );
    revealables.forEach((el) => {
      el.style.opacity = "0";
      io.observe(el);
    });
  }

  // Demo box: Esc -> NORMAL chip, i -> Insert chip. Mirrors extension feel.
  const area = document.getElementById("demoArea");
  const mode = document.getElementById("demoMode");
  if (area && mode) {
    let normal = false;
    const render = () => {
      mode.innerHTML = normal
        ? '<i class="dot lime"></i>Normal'
        : '<i class="dot green"></i>Insert';
    };
    area.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        normal = true;
        render();
      } else if (normal && (e.key === "i" || e.key === "a")) {
        // Let the character type only for i/a passthrough demo simplicity:
        // keep normal unless it's a plain insert entry.
        if (e.key === "i") {
          normal = false;
          render();
        }
      }
    });
    area.addEventListener("focus", render);
    render();
  }
})();
