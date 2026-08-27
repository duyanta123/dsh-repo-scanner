import { helper } from '@/util/helper';
import { legacy } from '@/legacy/old';
import { shared } from '@shared/consts';

export async function bootstrap(): Promise<void> {
  helper();
  legacy();
  shared();
}
