/* ============================================================
   RYUK* — project.js
   Data-driven project page logic
   ============================================================ */

"use strict";

// ── PROJECT DATA ────────────────────────────────────────────────────────
const PROJECTS = {
  nestora: {
    title: "NESTORA STUDIO®",
    category: "ARCHITECTURE & BRAND SYSTEM",
    year: "2024",
    client: "Nestora Studio™",
    services: "Interior Design, Spatial Branding, UI/UX",
    deliverables: "Visual Identity, Spatial Direction, Portfolio Website",
    overview: `Nestora Studio is a high-end interior design and spatial branding firm. They required a digital representation that mirrors the minimalist beauty, structural detail, and tactile quality of their physical spatial work.<br><br>We developed a refined portfolio showcase highlighting spatial narratives, combining strict editorial typography layouts with custom interactive transitions to elevate their premium brand authority.`,
    tagline: "Editorial spatial branding and interior design portfolio for discerning architects.",
    cover: "mockupshi/134.jpg",
    images: ["mockupshi/134.jpg", "mockupshi/135.png", "mockupshi/136.png", "mockupshi/137.png"],
    liveUrl: "http://netora-studio-interior-designing.vercel.app/",
    next: "theroom",
  },
  theroom: {
    title: "THE ROOM®",
    category: "EDITORIAL DESIGN & BRAND EXPERIENCE",
    year: "2025",
    client: "The Room Lounge",
    services: "Uzbek Fusion Dining, Brand Identity, UI/UX",
    deliverables: "Digital Brand System, Interactive Menu, Web Showcase",
    overview: `The Room is a premium Uzbek fusion dining and karaoke lounge. We translated the warm, immersive atmosphere and rich cultural flavor of their culinary space into a distinct, high-contrast, edge-to-edge web experience.<br><br>Features a customized interactive menu showcase and atmospheric photography layouts designed to evoke sensory connection and high engagement.`,
    tagline: "Uzbek fusion dining meets immersive premium karaoke and lounge experience.",
    cover: "mockupshi/138.png",
    images: ["mockupshi/138.png", "mockupshi/139.png", "mockupshi/140.png", "mockupshi/141.png"],
    liveUrl: "https://theroom-green.vercel.app/",
    next: "arena",
  },
  arena: {
    title: "ARENA PROJECT®",
    category: "CREATIVE ENGINEERING & MOTION DESIGN",
    year: "2025",
    client: "ABP Déménagement",
    services: "Creative Direction, Web Development, Motion Design",
    deliverables: "Web Experience, Interactive Timelines, Motion Framework",
    overview: `ABP Arena Project is an elite relocation and luxury logistics showcase. Designed as a high-fidelity web experience, the showcase conveys absolute security, extreme precision, and premium service execution.<br><br>Leveraging state-of-the-art interactive timelines and GSAP animations, the website guides users through complex logistics stories with absolute fluidity.`,
    tagline: "High-fidelity digital showcase celebrating elite transport and luxury logistics.",
    cover: "mockupshi/142.png",
    images: ["mockupshi/142.png", "mockupshi/143.png", "mockupshi/144.png", "mockupshi/145.png"],
    liveUrl: "https://019db62d-af13-70f3-a6cb-27a55d0fc5ae.arena.site/",
    next: "nestora",
  },
};

// ── PAGE INIT ───────────────────────────────────────────────────────────
function initProjectPage() {
  // Get project id from URL
  const params = new URLSearchParams(window.location.search);
  const id = params.get("project") || "nestora";
  const project = PROJECTS[id] || PROJECTS.nestora;

  // Set page title
  document.title = `${project.title.replace("®", "")} — Ryuk® Design Studio`;

  // Populate content
  const set = (elId, html) => {
    const el = document.getElementById(elId);
    if (el) el.innerHTML = html;
  };

  set("projCategory", project.category);
  set("projYear", project.year);
  set("projTitle", project.title);
  set("projTagline", project.tagline);
  set("projClient", project.client);
  set("projServices", project.services);
  set("projYearInfo", project.year);
  set("projDeliverables", project.deliverables);
  set("projOverview", project.overview);

  // Live links
  const liveLink = document.getElementById("projLiveLink");
  if (liveLink) {
    liveLink.href = project.liveUrl;
  }
  const liveHeroLink = document.getElementById("projLiveHeroLink");
  if (liveHeroLink) {
    liveHeroLink.href = project.liveUrl;
  }

  // Cover image
  const cover = document.getElementById("projCoverImg");
  if (cover) {
    cover.src = project.cover;
    cover.alt = project.title;
  }

  // Gallery images
  const galleryImgs = [...document.querySelectorAll(".proj-gallery-img")];
  project.images.forEach((src, i) => {
    if (galleryImgs[i]) {
      galleryImgs[i].src = src;
      galleryImgs[i].alt = project.title + " " + (i + 1);
    }
  });

  // Next project
  const nextData = PROJECTS[project.next];
  if (nextData) {
    const nextLink = document.getElementById("projNextLink");
    const nextTitle = document.getElementById("projNextTitle");
    if (nextTitle) nextTitle.textContent = nextData.title;
    if (nextLink) nextLink.href = `project.html?project=${project.next}`;
  }
}

// ── GSAP INIT (called from app.js afterLoad) ────────────────────────────
function initProjectAnimations() {
  gsap.registerPlugin(ScrollTrigger);

  // Cover parallax
  const coverImg = document.querySelector(".proj-cover-img");
  if (coverImg) {
    gsap.to(coverImg, {
      y: 80,
      ease: "none",
      scrollTrigger: {
        trigger: ".proj-cover",
        start: "top top",
        end: "bottom top",
        scrub: true,
      },
    });
  }

  // Gallery reveals
  document.querySelectorAll(".js-gallery-img").forEach((img, i) => {
    gsap.fromTo(
      img.parentElement,
      { opacity: 0, y: 48 },
      {
        opacity: 1,
        y: 0,
        duration: 0.9,
        delay: i * 0.05,
        ease: "expo.out",
        scrollTrigger: {
          trigger: img.parentElement,
          start: "top 88%",
        },
      }
    );
  });

  // Project title and next project title reveals (slide up from translateY(105%))
  document.querySelectorAll(".js-reveal").forEach((el) => {
    gsap.fromTo(
      el,
      { y: "105%" },
      {
        y: "0%",
        duration: 1.2,
        ease: "power4.out",
        scrollTrigger: {
          trigger: el.parentElement,
          start: "top 90%",
        },
      }
    );
  });
}

// ── BOOT ────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initProjectPage();
});

// Hook into app.js afterLoad
const _origAfterLoad = window.AppController?.afterLoad;
window.__projectInit = initProjectAnimations;
