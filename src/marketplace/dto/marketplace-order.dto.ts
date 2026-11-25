import { IsIn } from 'class-validator';

export class ListOrdersQueryDto {
  /** Which side of the order the authenticated user is on. */
  @IsIn(['buyer', 'seller'])
  role: 'buyer' | 'seller';
}
