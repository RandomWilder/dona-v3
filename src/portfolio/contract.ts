// The portfolio module's public surface. Nothing outside this module reaches
// past this file — internals live under `internal/`. See SPEC-portfolio.md.
export type {
  Actor,
  AddAssetInput,
  AddBuildingInput,
  AddUnitInput,
  Asset,
  AssetKind,
  Building,
  BuildingView,
  GetUnitOptions,
  Portfolio,
  PortfolioDeps,
  ScopedAsset,
  Unit,
  UnitView,
} from './internal/places.ts';
export { assetKinds, createPortfolio } from './internal/places.ts';
