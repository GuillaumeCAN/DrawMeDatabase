<?php

namespace App\Entity;

enum PostStatus: string
{
    case Draft = 'draft';
    case Published = 'published';
}
