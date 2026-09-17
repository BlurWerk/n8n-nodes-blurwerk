export interface Meta { duration: number; width: number; height: number; fps: number }
declare const probe: { read(file: Blob): Promise<Meta | null> };
export default probe;
